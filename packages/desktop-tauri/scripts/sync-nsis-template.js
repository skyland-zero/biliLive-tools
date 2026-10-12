/**
 * 生成 `src-tauri/nsis/installer.nsi`（Tauri NSIS 模板的本地分支）。
 *
 * ## 为什么需要这个脚本
 *
 * Tauri 默认的 NSIS 模板会把 node.exe / ffmpeg 等约 500MB 的 payload 逐个 `File` 进
 * 一个 `/SOLID lzma` 数据块，安装时用 NSIS 自带的 **单线程 LZMA1** 解码（实测约 25MB/s），
 * 并且 solid 模式下文件会先解到临时文件再拷贝到安装目录。结果就是安装包不小、装得还慢。
 *
 * electron-builder 的做法完全不同：payload 用 `7za -mx=9`（LZMA2，多线程）离线压成
 * `app-64.7z`，`SetCompress off` 塞进安装包，运行时用 `nsis7z` 插件解压，又快又小。
 *
 * 本脚本把 Tauri 官方模板拉下来，只做「换成 7z payload」这一处改动，其余保持原样，
 * 这样 Tauri 修 bug（安装路径、WebView2、卸载逻辑…）时用 `pnpm nsis:sync` 一条命令即可同步。
 *
 * ```bash
 * pnpm nsis:sync           # 按 package.json 里的 @tauri-apps/cli 版本重新生成
 * pnpm nsis:sync --check   # 只校验已提交的模板是否和当前补丁一致（CI 用）
 * pnpm nsis:sync --ref tauri-cli-v2.13.0   # 指定上游 tag
 * pnpm nsis:sync --from ./installer.nsi    # 用本地文件代替联网下载
 * ```
 *
 * 走了系统代理的机器上 node 的 fetch 默认不认 HTTP_PROXY，需要
 * `NODE_USE_ENV_PROXY=1 pnpm nsis:sync`，或用 `--from` 指定本地文件。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(packageDir, "../..");

const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
const cliVersion = String(pkg.devDependencies["@tauri-apps/cli"] ?? "").replace(/^[\^~]/, "");

const argv = process.argv.slice(2);
const checkOnly = argv.includes("--check");
const refArgIndex = argv.indexOf("--ref");
const gitRef = refArgIndex >= 0 ? argv[refArgIndex + 1] : `tauri-cli-v${cliVersion}`;
const fromArgIndex = argv.indexOf("--from");
const fromPath = fromArgIndex >= 0 ? argv[fromArgIndex + 1] : null;

const upstreamUrl = `https://raw.githubusercontent.com/tauri-apps/tauri/${gitRef}/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi`;
const outFile = path.join(packageDir, "src-tauri", "nsis", "installer.nsi");

/**
 * 对上游模板的补丁。`find` 必须在上游模板中**恰好出现一次**，否则脚本报错，
 * 提示需要人工适配（而不是悄悄生成一个坏的模板）。
 */
const PATCHES = [
  {
    name: "appendix",
    // 在文件开头插入说明，方便和维护者沟通「这个模板是 fork 的」
    find: `Unicode true\n`,
    replace: `; ============================================================================
; 本文件由 packages/desktop-tauri/scripts/sync-nsis-template.js 生成，请勿手工修改。
;   上游：${upstreamUrl}
;   同步：pnpm nsis:sync
;
; 与上游的唯一区别：不再把每个 resource / external binary 单独 File 进 solid LZMA 数据块，
; 改成把构建期压好的 payload.7z 原样塞进安装包（SetCompress off + nsis7z 多线程解压）。
; 详见 prepare-nsis.js 与 README.md。
; ============================================================================

Unicode true
`,
  },
  {
    name: "compression",
    // 1) /SOLID 会让 SetCompress off 失效（makensis warning 8021），payload 会被二次压缩；
    // 2) solid 模式下 NSIS 先把文件解到临时文件再拷贝，等于双倍磁盘 IO。
    // electron-builder 出于同样原因也不用 /SOLID（见 app-builder-lib NsisTarget.js）。
    find: `  ; Set the compression algorithm. We default to LZMA.
  SetCompressor /SOLID "{{compression}}"
`,
    replace: `  ; 注意：这里不能用 /SOLID，否则下面的 SetCompress off 会被忽略（makensis warning 8021），
  ; payload 会被 NSIS 二次压缩；而且 solid 模式下文件会先解到临时文件再拷贝到安装目录。
  SetCompressor "{{compression}}"
`,
  },
  {
    name: "plugin-dir",
    find: `!addplugindir "{{signed_plugins_path}}"
{{/if}}
`,
    replace: `!addplugindir "{{signed_plugins_path}}"
{{/if}}

; nsis7z：解压构建期压好的 payload.7z（路径由 prepare-nsis.js 注入）
!addplugindir /x86-unicode "@BILILIVE_NSIS7Z_DIR@"
`,
  },
  {
    name: "install-payload",
    find: `  ; Copy resources
  {{#each resources_dirs}}
    CreateDirectory "$INSTDIR\\\\{{this}}"
  {{/each}}
  {{#each resources}}
    File /a "/oname={{this.[1]}}" "{{no-escape @key}}"
  {{/each}}

  ; Copy external binaries
  {{#each binaries}}
    File /a "/oname={{this}}" "{{no-escape @key}}"
  {{/each}}
`,
    replace: `  ; 大体积 payload（node.exe / bin / cli）在构建期已压成 7z：
  ; 原样写入安装包不做二次压缩，再用 nsis7z（7-Zip SDK，多线程）解压到 $INSTDIR。
  SetCompress off
  InitPluginsDir
  File "/oname=$PLUGINSDIR\\payload.7z" "@BILILIVE_PAYLOAD_7Z@"
  SetCompress auto
  nsis7z::Extract "$PLUGINSDIR\\payload.7z"
  Delete "$PLUGINSDIR\\payload.7z"
`,
  },
  {
    name: "uninstall-payload",
    find: `  ; Delete resources
  {{#each resources}}
    Delete "$INSTDIR\\\\{{this.[1]}}"
  {{/each}}

  ; Delete external binaries
  {{#each binaries}}
    Delete "$INSTDIR\\\\{{this}}"
  {{/each}}
`,
    replace: `  ; 删除 payload 解出来的内容（目录清单与 prepare-nsis.js 的 payload 布局一致）
  RMDir /r "$INSTDIR\\bin"
  RMDir /r "$INSTDIR\\cli"
  Delete "$INSTDIR\\node.exe"
`,
  },
  {
    name: "uninstall-ancestors",
    // resources 已经不打进安装包了，对应的父目录清理逻辑也就没有意义
    find: `  {{#each resources_ancestors}}
  RMDir /REBOOTOK "$INSTDIR\\\\{{this}}"
  {{/each}}
  RMDir "$INSTDIR"
`,
    replace: `  RMDir "$INSTDIR"
`,
  },
];

function applyPatches(upstream) {
  let output = upstream;
  for (const patch of PATCHES) {
    const occurrences = output.split(patch.find).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `[nsis] 补丁「${patch.name}」在 ${gitRef} 的模板中匹配到 ${occurrences} 处（期望 1 处）。\n` +
          `上游模板可能改动了，请检查 scripts/sync-nsis-template.js 里的 PATCHES。\n` +
          `--- 期望匹配的内容 ---\n${patch.find}`,
      );
    }
    output = output.replace(patch.find, patch.replace);
  }
  return output;
}

async function main() {
  const generated = applyPatches(await fetchUpstream());

  if (checkOnly) {
    const current = fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : null;
    if (current === generated) {
      console.log(`[nsis] ${path.relative(repoRoot, outFile)} 与 ${gitRef} 一致`);
      return;
    }
    console.error(
      `[nsis] ${path.relative(repoRoot, outFile)} 已过期，请运行 \`pnpm nsis:sync\` 重新生成`,
    );
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, generated);
  console.log(`[nsis] 已生成 ${path.relative(repoRoot, outFile)}（基于 ${gitRef}）`);
}

async function fetchUpstream() {
  if (fromPath) {
    const file = path.resolve(process.cwd(), fromPath);
    console.log(`[nsis] 使用本地模板：${file}`);
    return fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  }
  console.log(`[nsis] 拉取上游模板：${upstreamUrl}`);
  const response = await fetch(upstreamUrl);
  if (!response.ok) {
    throw new Error(`[nsis] 拉取上游模板失败：HTTP ${response.status} ${upstreamUrl}`);
  }
  return (await response.text()).replace(/^\uFEFF/, "");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
