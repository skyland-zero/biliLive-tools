# Tauri 桌面端设计方案

> 状态：设计稿（未实施）
> 目标：用 Tauri 2 增加一个桌面端外壳，复用现有全部 Node 后端与 Vue 渲染层。

---

## 1. 目标与范围

### 目标

- 新增一个 Tauri 桌面端发行版，**不重写后端**
- 渲染层（36,949 行 Vue/TS）**零业务改动**
- 后端（`shared` / `http` / `liveManager` / `StreamGet` / `types` ≈ 57,000 行）**原样复用**
- 与 Electron 版长期共存，避免业务代码双份维护

### 非目标

- 用 Rust 重写录制/上传/弹幕逻辑（不现实：含大量逆向协议）
- 替换 Electron 版（v1 阶段并存）
- 提供比 Electron 版更小的安装包（收益有限，见 §6.3）

---

## 2. 现状约束（已核实的事实）

| #   | 事实                                                           | 证据                                                                                                                                                                   |
| --- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | 后端已是独立 Node 服务，CLI 可单独拉起                         | `packages/CLI/src/index.ts:35` `bililive-cli server --config`；docker `ENTRYPOINT ["node","index.cjs","server"]`                                                       |
| C2  | 后端不托管前端静态文件                                         | `packages/http/src/index.ts:81` 根路径返回 `Not for browser use`；`http/middleware` 无 static                                                                          |
| C3  | 渲染层 HTTP 优先                                               | `renderer/src/apis/request.ts`；仅从 IPC 取 `port` / `passKey` 后全部走 HTTP                                                                                           |
| C4  | IPC 面极小                                                     | `ipcMain.handle` 共 10 个；renderer 内 `window.api.*` 调用点 **39 处**                                                                                                 |
| C5  | Electron main 仅 1,429 行                                      | `packages/app/src/main/{index,common,handlers}.ts`                                                                                                                     |
| C6  | renderer 依赖 `window.path`（42 处），但**项目自带跨平台方案** | `renderer/src/main.ts:12-16` 在 web 模式注入 `path-unified`；desktop 模式由 preload 注入 `node:path`。`path-unified` 已在 webui 模式对同一后端验证通过                 |
| C7  | renderer 不使用 `window.electron`                              | 0 处                                                                                                                                                                   |
| C7b | **拖拽依赖 Electron 专有 API，Tauri 下会失效**                 | `FileArea.vue:130/162`、`Burn/components/FileSelect.vue:181/191`、`FileUpload/components/FileSelect.vue:123/152` 均为 `useDropZone`(HTML5) + `webUtils.getPathForFile` |
| C7c | Tauri 的 `dragDropEnabled` 与 HTML5 drop **互斥**              | `true` → 原生事件给绝对路径但 HTML5 drop 被拦截；`false` → HTML5 可用但 `File` 拿不到路径                                                                              |
| C8  | CLI 产物已把 JS 打成 bundle，仅 6~8 个原生模块 externals       | `packages/CLI/rollup.config.js` external 列表                                                                                                                          |
| C9  | 原生模块清单                                                   | `better-sqlite3` `@napi-rs/canvas` `font-ls` `ntsuspend` `shazamio-core` `music-segment-detector`（+ `meyda` `bindings` `file-uri-to-path`）                           |
| C10 | 播放在 Artplayer 内已做能力探测与降级                          | `components/Artplayer/Index.vue:166` `mpegts.isSupported()` / `Hls.isSupported()`                                                                                      |
| C11 | Tauri ≥ 2.4.0 提供原生 cookie 读取（含 HttpOnly）              | `WebviewWindow::cookies()` / `cookies_for_url()`                                                                                                                       |
| C12 | 当前发行物体积                                                 | win `216MB` / win-zip `283MB` / linux-zip `260MB` / mac-dmg `209MB`                                                                                                    |

---

## 3. 总体架构

```
┌─ Tauri v2 外壳 (Rust, 薄) ────────────────────────────────────────┐
│                                                                   │
│  ┌─ Webview ───────────────────────────────────────────────────┐  │
│  │  packages/app/src/renderer  (36,949 行，零业务改动)          │  │
│  │      ├─ window.api   ←── 适配层 (Tauri invoke 实现)          │  │
│  │      ├─ window.path  ←── 适配层 (平台感知 path shim)         │  │
│  │      └─ HTTP/SSE ────────────┐                              │  │
│  └──────────────────────────────┼──────────────────────────────┘  │
│                                 │ http://127.0.0.1:<port>        │
│  ┌─ Rust 主进程 ────────────────▼──────────────────────────────┐  │
│  │  进程管理: 拉起/守护/关闭 sidecar, 健康检查, 端口与 passKey  │  │
│  │  原生能力: dialog / opener / tray / updater / autostart /    │  │
│  │            cookie 登录窗 / 子窗口 / powerSaveBlocker         │  │
│  └──────────────────────────────┬──────────────────────────────┘  │
│                                 │ spawn                          │
│  ┌─ Node sidecar (externalBin) ─▼─────────────────────────────┐   │
│  │  node + CLI/lib/*.cjs + 原生模块                            │   │
│  │  = @biliLive-tools/http serverStart  (100% 复用)            │   │
│  │      └─ child_process: ffmpeg / DanmakuFactory / mesio /    │   │
│  │                        BililiveRecorder / aliyunpan / …     │   │
│  └─────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────┘
```

**一句话**：Tauri 只做「窗口 + 原生能力 + 进程管理」，业务全部交给现有 Node 后端。

---

## 4. 目录结构

```
packages/
├── app/                      # 现有 Electron 版（不动）
├── renderer-adapter/         # ★ 新增：window.api / window.path 的统一契约与实现
│   ├── src/
│   │   ├── types.ts          # window.api 的接口定义（从 preload 抽出）
│   │   ├── electron.ts       # 内部使用，仅类型；实际由 app/preload 提供
│   │   ├── tauri/            # Tauri 实现
│   │   │   ├── index.ts      # installWindowApi()
│   │   │   ├── common.ts
│   │   │   ├── config.ts
│   │   │   ├── dialog.ts
│   │   │   ├── cookie.ts
│   │   │   └── path.ts       # window.path shim
│   │   └── web.ts            # 浏览器实现（可选，给 webui 复用）
│   └── package.json
└── desktop-tauri/            # ★ 新增：Tauri 外壳
    ├── package.json
    ├── vite.config.ts        # root 指向 ../app/src/renderer
    ├── index.html
    ├── src/main.ts           # 先 installWindowApi()，再 import renderer 的 main.ts
    └── src-tauri/
        ├── Cargo.toml
        ├── tauri.conf.json
        ├── capabilities/
        └── src/
            ├── main.rs
            ├── sidecar.rs    # Node 进程生命周期
            ├── config.rs     # 读写 appConfig.json
            ├── cookie.rs     # 登录窗 + cookies()
            ├── windows.rs    # 主窗/子窗/托盘
            └── power.rs      # 防休眠
```

### 前端复用的关键

`packages/desktop-tauri/vite.config.ts` 把 root 指向现有 renderer，并注入适配层：

```ts
export default defineConfig({
  root: resolve(__dirname, "../app/src/renderer"),
  resolve: {
    alias: {
      "@renderer": resolve(__dirname, "../app/src/renderer/src"),
      "@desktop": resolve(__dirname, "src"),
    },
  },
  plugins: [
    vue(),
    // 把 renderer 入口重写为「先装适配层，再跑原入口」
    {
      name: "inject-desktop-adapter",
      transformIndexHtml(html) {
        return html.replace(
          '<script type="module" src="/src/main.ts">',
          '<script type="module" src="/@desktop/bootstrap.ts">',
        );
      },
    },
  ],
});
```

`src/bootstrap.ts`：

```ts
import { installWindowApi } from "@desktop/adapters/tauri";
await installWindowApi(); // 写入 window.api / window.path / window.isWeb
await import("@renderer/main"); // 原 renderer 入口，一行不改
```

> renderer 的 `main.ts` 里 `window.isWeb = !window.api` 会得到 `false`，
> 因此走「桌面模式」分支：从 `window.api.config.getAll()` 拿 `port` + `passKey`，其余全走 HTTP。

---

## 5. 关键技术决策

### 5.1 后端：Node sidecar，不重写

**决策**：sidecar 直接跑 `packages/CLI` 的 `server` 命令。

**理由**：后端 57,000 行含大量逆向实现（斗鱼 h5-play、抖音 protobuf、虎牙 Taf、B 站 API）。Rust 重写等于重做整个项目。

**代价**：必须随包分发 Node 运行时（win 平台 `node.exe` ≈ 80MB 未压缩 / 压缩后 ≈ 30MB）。这是本方案最大的体积成本，也是它相对 Electron 收益有限的原因。

### 5.2 sidecar 打包方式

| 方案                                    | 评价                                                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **A. `node` 二进制 + CLI 产物（推荐）** | Tauri `bundle.externalBin` 放 `node-<triple>`，`bundle.resources` 放 `cli/`。改动最小，原生模块 ABI 直接对齐官方 Node |
| B. Node SEA 单文件                      | `.node` 原生模块无法进 SEA blob，仍需外置；调试困难                                                                   |
| C. `pkg` / `nexe`                       | `pkg` 已停止维护，不支持 Node 22+                                                                                     |
| D. Deno / Bun 编译                      | 原生模块兼容性风险高（`better-sqlite3` / `shazamio-core`），不赌                                                      |

**方案 A 的产物布局**：

```
resources/
├── node/node.exe              # externalBin（Tauri 会做 triple 后缀处理）
├── cli/
│   ├── index.cjs              # rollup 产物
│   ├── <chunk>-<hash>.cjs
│   ├── package.json
│   └── node_modules/          # 仅 6~8 个 external 原生模块
│       ├── better-sqlite3/
│       ├── @napi-rs/canvas/
│       ├── font-ls/ ntsuspend/ shazamio-core/ music-segment-detector/
│       └── meyda/ bindings/ file-uri-to-path/
└── bin/                       # 外部工具（见 §5.11）
    ├── ffmpeg / ffprobe / DanmakuFactory / mesio / BililiveRecorder.Cli
```

复用现成的 `packages/CLI/scripts/copy_module.js` 来生成 `cli/node_modules`（它就是干这个的）。

**原生模块 ABI**：这里用的是**官方 Node**，不是 Electron，所以：

- 不需要 `@electron/rebuild`
- `better-sqlite3` 直接用它自己的 node prebuild 即可
- 各平台必须在**对应平台的 CI runner** 上构建（沿用现有 release.yml 的 matrix）

### 5.3 启动契约（Rust ↔ sidecar）

Tauri 启动时：

1. 解析数据目录（`%APPDATA%/biliLive-tools`、`~/Library/Application Support/…`、`~/.config/…`）
2. 生成/读取 `config.json`（sidecar 的配置文件，字段见 `packages/CLI/src/index.ts` 的 `Config`）：

```json
{
  "port": 18010,
  "host": "127.0.0.1",
  "configFolder": "<userData>",
  "ffmpegPath": "<resource>/bin/ffmpeg.exe",
  "ffprobePath": "<resource>/bin/ffprobe.exe",
  "mesioPath": "<resource>/bin/mesio.exe",
  "bililiveRecorderPath": "<resource>/bin/BililiveRecorder.Cli.exe",
  "audiowaveformPath": "audiowaveform",
  "danmakuFactoryPath": "<resource>/bin/DanmakuFactory.exe",
  "logPath": "<userData>/main.log"
}
```

3. **端口探测**：从 18010 起向上找可用端口（避免与正在运行的 Electron 版/另一个 Tauri 实例冲突）
4. **passKey**：首次启动生成随机 UUID 写入 `<userData>/appConfig.json`，通过环境变量 `BILILIVE_TOOLS_PASSKEY` 传给 sidecar（CLI 已支持该 env，见 `packages/CLI/src/index.ts`）
5. spawn：`node cli/index.cjs server --config <userData>/config.json --host 127.0.0.1 --port <port>`
6. **健康检查**：轮询 `GET /common/version` 直到 200，超时则报错并展示日志
7. 就绪后创建主窗口（或先显示 splash）

**`config_get_all` 的实现**：Tauri 直接读 `<userData>/appConfig.json`（`serde_json`），不经过 sidecar —— 因为 renderer 需要先拿到 `port`/`passKey` 才能发 HTTP 请求，存在先有鸡后有蛋。

### 5.4 生命周期与退出

| 场景         | 处理                                                                                                                                                              |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 正常退出     | 先请求后端优雅退出 → 等待 → `kill`                                                                                                                                |
| sidecar 崩溃 | 记录日志 + 托盘通知；可选自动重启（限 3 次/5 分钟）                                                                                                               |
| Tauri 崩溃   | sidecar 需自己退出 → 用 **Job Object**（Windows）/ `prctl(PR_SET_PDEATHSIG)`（Linux）/ `kqueue`（macOS）保证子进程不残留；Tauri 官方 sidecar 支持有限，需自己实现 |
| 用户点关闭   | 走「最小化到托盘」还是有确认框，沿用 Electron 版行为                                                                                                              |

> **实际处理**：让 sidecar 以 `--parent-pid <pid>` 启动，sidecar 侧轮询父进程存活（最简单、跨平台），或在 Rust 侧注册 `RunEvent::Exit` 钩子主动 kill。

### 5.5 IPC 适配层（39 处调用的完整映射）

| `window.api.*`                                         | 调用数      | Tauri 实现                                                                                                         |
| ------------------------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------ |
| `openFile(opts)`                                       | 6           | `tauri-plugin-dialog` `open({ multiple: true, filters })`                                                          |
| `openDirectory(opts)`                                  | 2           | `open({ directory: true })`                                                                                        |
| `showSaveDialog(opts)`                                 | 2           | `save(opts)`                                                                                                       |
| `openExternal(url)`                                    | 4           | `tauri-plugin-opener` `openUrl(url)`                                                                               |
| `openPath(path)`                                       | 6           | `tauri-plugin-opener` `openPath(path)`                                                                             |
| `exits(path)`                                          | 1           | `invoke('path_exists')`（Rust `Path::exists`）                                                                     |
| `common.showItemInFolder(p)`                           | 2           | `invoke('show_in_folder')`（Rust `reveal_in_file_manager`）                                                        |
| `common.createSubWindow(opts)`                         | 4           | `invoke('create_sub_window')` → `WebviewWindowBuilder`                                                             |
| `common.getPathForFile(file)`                          | 3           | ⚠️ **无法直接实现**，见 §5.7。建议整体替换为 `useFileDropZone` composable                                          |
| `common.readFile/writeFile`                            | 1           | `tauri-plugin-fs`（注意 capability 白名单），或改走 HTTP `/files`                                                  |
| `common.execFile`                                      | 1           | `tauri-plugin-shell` 的 `Command`（需白名单）                                                                      |
| `common.checkUpdate`                                   | 1           | 源码探测走 HTTP `/common/checkUpdate`（已有）；安装走 `tauri-plugin-updater`                                       |
| `common.relaunch`                                      | 0（已暴露） | `tauri-plugin-process` `relaunch()`                                                                                |
| `common.setOpenAtLogin`                                | 0（已暴露） | `tauri-plugin-autostart`                                                                                           |
| `common.setTheme`                                      | 0（已暴露） | `invoke('set_theme')` → `Window::set_theme`                                                                        |
| `common.setMenuBarVisible`                             | 1           | **无等价物**。Windows 菜单栏是 Electron 概念。改成：Rust 侧控制一个自定义标题栏，或前端 CSS 隐藏。**列为已知差异** |
| `config.getAll/set/save/get`                           | 4           | Rust 直接读写 `appConfig.json`；`set` 同时需 `invoke` 通知 sidecar 重载                                            |
| `cookie.baidu/xhs/douyinLogin`                         | 3           | `WebviewWindow` + `cookies_for_url()`（Tauri ≥ 2.4.0）                                                             |
| `dbQuery/dbList/addWithStreamer/mergeAssMp4/...`       | 0           | 已在 renderer 走 HTTP 或无调用点，无需实现                                                                         |
| `onMainNotify / openSetting / openLog / openChangelog` | 事件        | `listen()` 订阅 Rust `emit`                                                                                        |

**`window.path`（42 处）：不需要新写 shim**

项目自己已经有跨平台方案（事实 C6）。`renderer/src/main.ts` 在 web 模式下就是注入 `path-unified`，而 `path-unified` 已经在 webui 模式下对同一后端验证通过。

适配层只需在 bootstrap 里补一句（因为装了 `window.api` 后 `isWeb` 为 `false`，不会走 main.ts 的注入分支）：

```ts
import path from "path-unified";
window.path = path;
```

**风险等级：可忽略。** 无需 `pathe`、无需探测分隔符。

### 5.6 Cookie 登录窗（原先最大的风险，已解除）

Tauri **≥ 2.4.0** 原生支持从 webview 读 cookie，且包含 HttpOnly：

```rust
// Rust 侧
fn login_cookie(app: AppHandle, url: String, domains: Vec<String>) -> Result<String> {
    let win = WebviewWindowBuilder::new(&app, "login", WebviewUrl::External(url.parse()?))
        .title("登录")
        .inner_size(1200.0, 800.0)
        .build()?;

    // 等窗口关闭后取 cookie
    // win.cookies_for_url(url) -> Vec<tauri::webview::Cookie>
    // 按 domain 过滤，拼成 "k=v; k=v"
}
```

对齐现有实现（`packages/app/src/main/cookie.ts`）：

| 平台     | 登录 URL                          | 过滤 domain           |
| -------- | --------------------------------- | --------------------- |
| 百度网盘 | `https://pan.baidu.com/disk/main` | `pan.baidu.com`       |
| 小红书   | `https://www.xiaohongshu.com/`    | `www.xiaohongshu.com` |
| 抖音     | `https://www.douyin.com/`         | `.douyin.com`         |

**注意**：这三个平台可能检测 UA / 自动化特征。现有 Electron 实现用的是固定 macOS Edge 115 UA，Tauri 侧需要能覆写 UA（wry 支持 `with_user_agent`）。

### 5.7 拖拽桥接（唯一的强制性 renderer 改动）

**问题**：现有拖拽是 `@vueuse/core` 的 `useDropZone`（HTML5 事件）+ `webUtils.getPathForFile`（Electron 专有）。
Tauri 无法同时满足两者（事实 C7c），**不改代码则拖拽直接失效**。

**方案**：抽出项目内 composable，收敛 Electron 专有逻辑。

```ts
// packages/app/src/renderer/src/composables/useFileDropZone.ts
export function useFileDropZone(
  el: Ref<HTMLElement | null>,
  handlers: { onDropPaths: (paths: string[]) => void; onOver?: (e: DragEvent) => void },
) {
  if (window.api?.dragDrop) {
    // Tauri：原生事件 + elementFromPoint 命中测试
    return useTauriDropZone(el, handlers);
  }
  // Electron / 浏览器：维持现状
  const { isOverDropZone } = useDropZone(el, {
    onDrop: (files) =>
      handlers.onDropPaths((files ?? []).map((f) => window.api.common.getPathForFile(f))),
    onOver: (_f, e) => handlers.onOver?.(e),
  });
  return { isOverDropZone };
}
```

**改动清单**（3 个文件）：

| 文件                                                     | 改动                                            |
| -------------------------------------------------------- | ----------------------------------------------- |
| `components/FileArea.vue`                                | import + `onDrop(files)` → `onDropPaths(paths)` |
| `pages/Tools/pages/Burn/components/FileSelect.vue`       | 同上                                            |
| `pages/Tools/pages/FileUpload/components/FileSelect.vue` | 同上                                            |

> 该重构对 Electron 版也是净收益：把散落 3 处的 `getPathForFile` 收敛到一处。

### 5.8 播放器兼容性（平台差异矩阵）

不在 Artplayer 里落地的兼容性由 `mpegts.isSupported()` / `Hls.isSupported()` 自动降级为「不支持的格式」提示，**不会崩溃**，但功能缺失。

| 平台    | Webview                   | mpegts.js (FLV/MSE)                                | hls.js                 | 结论                  |
| ------- | ------------------------- | -------------------------------------------------- | ---------------------- | --------------------- |
| Windows | WebView2（Chromium 内核） | ✅ 完整                                            | ✅                     | **完全对等 Electron** |
| macOS   | WKWebView                 | ⚠️ 文档称 Safari 10.1+ 支持，需实测                | ⚠️ 有原生 HLS 回退分支 | 需实测                |
| Linux   | WebKitGTK 4.1             | ❌ 高风险（MSE 默认可能关闭，依赖 GStreamer 插件） | ⚠️                     | **不承诺**            |

**风险缓解（可选增强，对 webui 也受益）**：

后端现已具备视频流式接口（`http/src/routes/common.ts` 的 `applyVideoId` / `getVideo`，支持 Range）。
可在 http 增加 `?transmux=hls` 参数，用 ffmpeg `-c copy -f hls` 或分片 fMP4 输出，前端在 `mpegts.isSupported() === false` 时回退到 hls.js 或原生 HLS 播放。

这项工作独立于 Tauri，能同时修复 macOS/Linux webui 的播放问题，建议**单独立项**。

### 5.9 平台能力补齐

| Electron 能力                      | Tauri 方案                                                                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `powerSaveBlocker`（阻止系统休眠） | **无插件**。自己写 ~100 行：Win `SetThreadExecutionState`、macOS `IOPMAssertionCreateWithName`、Linux `org.freedesktop.ScreenSaver` D-Bus |
| `crashReporter`（Sentry）          | `sentry` crate；或 v1 先不做，保留本地日志                                                                                                |
| `electron-log`                     | `tauri-plugin-log` + 现有后端日志（renderer 的日志接口已走 HTTP `/common/getLogContent`）                                                 |
| `electron-store`                   | 复用后端 `appConfig.json`，不引入第二份配置                                                                                               |
| 托盘                               | `tauri::tray`（内置）                                                                                                                     |
| 菜单/快捷键                        | `tauri::menu` + `tauri-plugin-global-shortcut`                                                                                            |
| 单实例                             | `tauri-plugin-single-instance`                                                                                                            |
| 窗口位置记忆                       | `tauri-plugin-window-state`                                                                                                               |
| `electron-updater`                 | `tauri-plugin-updater`（需自建 `latest.json` 端点；现有 `publish.url` 是占位符 `https://example.com/auto-updates`，需一并解决）           |

### 5.10 安全

- sidecar 只监听 `127.0.0.1`，端口动态分配
- `passKey` 随机生成，存 `appConfig.json`，通过 env 传给 sidecar；renderer 从 `config.getAll()` 获取
- Tauri capabilities 按最小权限配置：`dialog:allow-open` `opener:allow-open-path` `fs:allow-read-text-file`（限定 `$APPDATA/**`）`shell:allow-execute`（限定 sidecar）
- CSP：沿用 renderer 现状（注意现有 `index.html` 未设置严格 CSP）

### 5.11 外部二进制（ffmpeg 等）的分发

与 Electron 版保持一致：`scripts/install-bin.js` 下载到 `resources/bin`，打包时作为 `bundle.resources`。但建议**增加「不内置二进制」的发行变体**（Electron 版已有 `electron-builder-no-ffmpeg.yml`），因为：

- ffmpeg/ffprobe ≈ 80MB，mesio ≈ 10MB，录播姬 CLI ≈ 30MB，合计 ≈ 150MB
- 这是体积的**主要来源**，也是 Tauri 相对 Electron 收益被稀释的根本原因
- 首次启动检测缺失 → 引导用户下载或指定路径

---

## 6. 平台矩阵与风险

### 6.1 分阶段平台支持

| 阶段       | 平台            | 理由                                                              |
| ---------- | --------------- | ----------------------------------------------------------------- |
| v1         | **Windows x64** | WebView2 = Chromium，能力完全对等，风险最低                       |
| v1.1       | macOS arm64     | 需实测 WKWebView 的 MSE / cookie / 文件拖拽                       |
| v2（待定） | Linux           | WebKitGTK 播放能力高风险；且 Linux 用户已有 Docker fullstack 方案 |

### 6.2 风险登记

| 风险                            | 等级                | 缓解                                                              |
| ------------------------------- | ------------------- | ----------------------------------------------------------------- |
| Linux WebKitGTK 无法播放 FLV    | 高                  | 不发行 Linux Tauri 版；或做服务端 remux（§5.8）                   |
| ~~`window.path` 分隔符不一致~~  | ~~中~~ → **可忽略** | 项目已用 `path-unified`（事实 C6），直接复用                      |
| **拖拽在 Tauri 下失效**         | **高（确定发生）**  | §5.7 抽 `useFileDropZone`，改 3 个文件                            |
| sidecar 残留进程                | 中                  | 父进程存活探测 / Job Object                                       |
| 自动更新端点缺失                | 中                  | 现有 Electron 版的 `publish.url` 也是占位符，需一并设计           |
| 双外壳维护成本                  | 中                  | 靠 §5.5 适配层收敛，禁止在 renderer 里新增 `window.api` 调用      |
| Node 运行时体积（+80MB 未压缩） | 中                  | 无解，除非 Rust 重写后端                                          |
| macOS 代码签名/公证             | 中                  | 现有 `mac.identity: null` + `notarize: false`，Tauri 同样可先不做 |
| 原生模块跨平台构建              | 中                  | 各平台 CI runner 构建（沿用现有 matrix 思路）                     |

### 6.3 体积对比（估算，基于 C12 实测）

| 组成                 | Electron 版                  | Tauri 版                |
| -------------------- | ---------------------------- | ----------------------- |
| 自带浏览器内核       | Chromium ≈ 200MB 解包        | WebView2（系统提供）= 0 |
| Node 运行时          | 已含                         | `node.exe` ≈ 80MB 解包  |
| app 代码             | ≈ 10MB                       | ≈ 10MB                  |
| 外部二进制           | ≈ 150MB                      | ≈ 150MB                 |
| **安装包（压缩后）** | **216MB（实测）**            | **≈ 150~190MB（估算）** |
| **内存**             | 多一个 Chromium 进程 ≈ 150MB | **省 ≈ 150MB** ✅       |

> 结论：**体积收益约 15~30%，内存收益明显**。若把外部二进制改为按需下载，Tauri 版可降到 ≈ 60MB 量级 —— 那才是质变，但会牺牲开箱即用。

### 6.4 已知差异清单（vs Electron 版）

Windows 版完成差分测试后的预期结论是「**功能等价，仅有 4 项已知差异**」：

| #   | 差异                              | 严重度 | 处置                                                        |
| --- | --------------------------------- | ------ | ----------------------------------------------------------- |
| D1  | 拖拽实现重构（§5.7）              | 无感知 | 改 3 个文件，两个版本行为一致                               |
| D2  | 原生菜单栏（`setMenuBarVisible`） | 轻微   | 改为自定义标题栏控制，或该项设置失效                        |
| D3  | 自动更新短期内不可用              | 中     | 需先建 `latest.json` 端点；未完成前不建议开自动更新默认开关 |
| D4  | Sentry 崩溃上报未接               | 轻微   | Phase 2 用 `sentry` crate 补                                |

**平台相关差异**（非 bug，属能力边界）：

| 平台    | 差异                                                     |
| ------- | -------------------------------------------------------- |
| Windows | 无。WebView2 = Chromium，与 Electron 一致                |
| macOS   | FLV/MSE 播放需实测；若不支持则降级为「不支持的格式」提示 |
| Linux   | 同上，且风险更高 → v1 不发行                             |

### 6.5 验证方法（差分测试）

不依赖「应该没问题」，把 Electron 版当 oracle：

| 手段       | 做法                                                                      | 验收标准               |
| ---------- | ------------------------------------------------------------------------- | ---------------------- |
| 后端等价性 | 两版本指向**同一个 `userData` 目录**跑全流程，比对 SQLite 结果 + 产物文件 | 产物 hash / 表行数一致 |
| IPC 等价性 | 为 39 处 `window.api.*` 写契约测试（mock 两个实现）                       | 返回值结构一致         |
| 端到端     | 录制 5 分钟 → 弹幕转换 → 压制 → 上传（沙箱账号）                          | 全链路成功，产物可比   |
| 差异清单   | 维护「Electron 有 / Tauri 有 / 已知差异」表格                             | 差异仅限 D1~D4         |

---

## 7. 实施计划

### Phase 0 — Spike（3~5 天，验证高风险项）

- [ ] Tauri 窗口 + 拉起 sidecar（dev 模式直接用 `node packages/CLI/lib/index.cjs server`）
- [ ] 健康检查 + `config.getAll()` 让 renderer 拿到 port/passKey
- [ ] 验证三个最常用 IPC：`openFile` / `openPath` / `showSaveDialog`
- [ ] 验证 `cookies_for_url()` 能读到百度/小红书/抖音 cookie
- [ ] **决策点**：以上不过就终止，退回 Electron

### Phase 1 — MVP（2 周）

- [ ] `packages/renderer-adapter` 契约层 + Tauri 实现
- [ ] 完整 39 处 IPC 映射
- [ ] `window.path` shim + 回归测试
- [ ] 子窗口 / 托盘 / 单实例 / 窗口状态记忆
- [ ] sidecar 打包（node + CLI 产物 + 原生模块）
- [ ] 打包出 Windows 安装包，跑通「录制 → 压制 → 上传」主链路

### Phase 2 — 对齐（2 周）

- [ ] 自动更新（含 `latest.json` 端点方案）
- [ ] 防休眠 / 崩溃上报 / 日志
- [ ] macOS 构建与实测
- [ ] 与 Electron 版的行为差异清单与回归用例

### Phase 3 — 发行（1 周）

- [ ] CI matrix（windows / macos）
- [ ] 文档：`docs/guide/installation.md` 增加 Tauri 版
- [ ] 决定是否把 Linux 纳入

---

## 8. 与 Electron 版共存策略

**核心约束**：适配层是唯一的差异点，renderer 里不允许出现 Tauri / Electron 分支。

```
renderer (王)
   └── 只依赖 window.api 的接口契约 (packages/renderer-adapter/src/types.ts)
          ├── Electron 实现：packages/app/src/preload/index.ts（现状，加一行 `satisfies WindowApi`）
          └── Tauri 实现：packages/desktop-tauri/src/adapters/tauri
```

落地动作：

1. 把 preload 里的 `api` 对象类型抽到 `types.ts`，让两边都 `satisfies WindowApi`
2. 新增 `window.api` 调用时，ESLint 规则要求同时更新 `types.ts`，编译器会强制两边实现
3. renderer 里 `window.isWeb` 分支保持不动（Tauri 走桌面模式）

---

## 9. 构建与 CI

```yaml
# .github/workflows/release-tauri.yml (草案)
strategy:
  matrix:
    include:
      - os: windows-2022
        target: x86_64-pc-windows-msvc
      - os: macos-15
        target: aarch64-apple-darwin

steps:
  - pnpm install
  - pnpm run build:base # 复用现有基础包构建
  - pnpm run --filter bililive-cli build # sidecar 产物 + copy_module
  -  # 下载 node 二进制 → src-tauri/binaries/node-<target>[.exe]
  -  # 下载外部二进制 → resources/bin
  - pnpm tauri build --target <target>
```

`tauri.conf.json` 关键字段：

```jsonc
{
  "productName": "biliLive-tools",
  "identifier": "com.skyland.bililivetools",
  "bundle": {
    "externalBin": ["binaries/node"],
    "resources": {
      "cli/": "cli/",
      "bin/": "bin/",
    },
    "targets": ["nsis", "dmg"],
  },
}
```

---

## 10. 待确认

1. **Linux 是否纳入**？若纳入必须先解决 WebKitGTK 播放问题（§5.8），否则只能发「无预览播放」的残缺版。
2. **是否要做「不内置 ffmpeg」的发行变体**？这是体积质变的唯一途径。
3. **自动更新端点**：现在 Electron 版的 `publish.url` 是 `https://example.com/auto-updates` 占位符。Tauri 需要一个真实的 `latest.json` 端点，是否一并设计？
4. **是否先抽出 `packages/renderer-adapter`**？如果最终只做 Windows 且不打算长期 coexist，可以直接在 `desktop-tauri` 里内联实现，省掉抽象层。
5. **v1 是否保留 Sentry 崩溃上报**？
