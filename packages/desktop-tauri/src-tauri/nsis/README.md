# NSIS 安装包定制说明

这个目录存放 Tauri NSIS 安装包的模板与插件。目标只有一个：**把 ~500MB 的 payload 打得又小装得又快。**

## 为什么要改

Tauri 默认的 NSIS 模板会把 `bundle.resources` / `bundle.externalBin` 里的每个文件
逐个 `File` 进一个 `/SOLID lzma` 数据块，安装时由 NSIS 自带的 **单线程 LZMA1** 解码器解压。
payload 里是 ffmpeg / ffprobe（各 ~127MB）、node.exe（101MB）、cli 依赖等，结果就是：

- 解码速率只有 ~25MB/s（NSIS 文档自己写的是 10–20MB/s @2GHz），500MB 要 20s 以上；
- solid 模式下文件还会**先解到临时文件再拷贝**到安装目录，等于双倍磁盘 IO；
- solid 模式下 `SetCompress off` 会被忽略（makensis warning 8021），没法让某些文件不压缩。

electron-builder 的做法完全不同：payload 用 `7za -mx=9`（LZMA2，**多线程**）离线压成
`app-64.7z`，`SetCompress off` 塞进安装包，运行时用 `nsis7z` 插件解压。

**实测对比**（Ryzen 7 5800H，521MB payload，静默安装到同一目录）：

| 方案                                             | 安装包     | 安装耗时  |
| ------------------------------------------------ | ---------- | --------- |
| `/SOLID lzma`（Tauri 默认）                      | 159 MB     | 20.7 s    |
| `zlib`（非 solid）                               | 208 MB     | 6.9 s     |
| **预压 7z + nsis7z（本目录，与 electron 一致）** | **150 MB** | **8.7 s** |

选了 7z：比默认方案**又小又快**；相比 zlib 只慢 1.8s，但安装包小 58MB（每个下载的人都少下 58MB）。

## 文件说明

| 文件                             | 说明                                                                                    |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| `installer.nsi`                  | Tauri NSIS 模板的本地 fork，**由脚本生成，不要手改**                                    |
| `installer.generated.nsi`        | 构建期生成（gitignore）：占位符被替换成绝对路径后的最终模板                             |
| `plugins/x86-unicode/nsis7z.dll` | 7z 解压插件（与 electron-builder 用的是同一个二进制），来源与许可见同目录 `LICENSE.txt` |

## 工作流程

```
tauri build
  └─ beforeBundleCommand: pnpm nsis:prepare
       ├─ 读 tauri.conf.json 的 bundle.resources / bundle.externalBin  ← payload 的唯一清单
       ├─ 过滤掉 *.pdb / *.xml / *.md / *.log / logs/，拷到 target/nsis-payload/stage
       ├─ 7za -mx=9 压成 target/nsis-payload/payload.7z（mtime 未变则跳过）
       └─ 替换占位符 → nsis/installer.generated.nsi
  └─ tauri-bundler 渲染模板 → target/release/nsis/x64/installer.nsi
       ├─ SetCompress off + File "payload.7z"（原样存储，不二次压缩）
       ├─ nsis7z::Extract 解压到 $INSTDIR
       └─ makensis → biliLive-tools_<version>_x64-setup.exe
```

`tauri.conf.json` 里 `bundle.resources` / `bundle.externalBin` **仍然保留**：模板已经不再直接
`File` 它们，它们现在的唯一作用是给 `prepare-nsis.js` 当 payload 清单（顺带让 Tauri 帮我们校验
这些路径存在）。要往安装包里加文件，改这里 + 保持 `installer.nsi` 卸载段一致即可。

## 模板怎么同步上游

```bash
# 按 package.json 里 @tauri-apps/cli 的版本重新拉取上游模板并套用补丁
pnpm nsis:sync

# 只校验已提交的 installer.nsi 是否与补丁一致（CI 用）
pnpm nsis:check

# 指定上游 tag / 用本地文件（走代理的机器上 node fetch 不认 HTTP_PROXY）
pnpm nsis:sync --ref tauri-cli-v2.13.0
NODE_USE_ENV_PROXY=1 pnpm nsis:sync
```

补丁内容定义在 `scripts/sync-nsis-template.js` 的 `PATCHES` 里，一共 6 处：
`/SOLID` → 非 solid、加插件目录、安装段换成 7z 解压、卸载段换成对应目录清理。
任一补丁在上游匹配不到（或匹配到多处）脚本会直接报错，提示人工适配——**不会**悄悄生成一个坏模板。

## 卸载注意

卸载段按 `payload.7z` 的实际布局清理：

```
RMDir /r "$INSTDIR\bin"     ; packages/app/resources/bin
RMDir /r "$INSTDIR\cli"     ; packages/CLI/lib
Delete "$INSTDIR\node.exe"  ; src-tauri/binaries/node-<triple>
```

**往 payload 里加减目录时，`installer.nsi` 的卸载段必须同步修改**，否则会残留文件导致
`RMDir "$INSTDIR"` 失败、卸载不干净。（`--check` 模式帮不上这个忙，因为这是补丁的固定文案。）
