/**
 * 确保 CLI 产物里的原生模块与「捆绑的 node 运行时」ABI 匹配。
 *
 * ## 为什么会有这个脚本
 *
 * sidecar 执行的是 `src-tauri/binaries/node-<target-triple>`，**不是开发机上的 node**。
 * 而 `packages/CLI/scripts/copy_module.js` 是从 pnpm store 直接拷贝原生模块的，那份产物
 * 历史上会被 `packages/app` 的 `postinstall: electron-builder install-app-deps`
 * 重建为 Electron ABI，任何官方 Node 都加载不了它。
 *
 * 症状：安装后打开一直停在「正在启动…」，`sidecar.log` 里是
 * `ERR_DLOPEN_FAILED ... was compiled against a different Node.js version`。
 *
 * ## 现状（better-sqlite3 v13 之后）
 *
 * 此前的唯一修复对象 `better-sqlite3` 自 v13 起改用 N-API（`binding.gyp` 里
 * `NAPI_VERSION=10` + `node-addon-api`），npm 包内直接附带 `prebuilds/<platform>-<arch>.node`。
 * N-API 二进制跨 Node / Electron 版本通用，**同一个文件**即可同时服务桌面版和 sidecar，
 * 因此不再需要从上游拉 prebuild 覆盖。（它的 `binding.gyp` 还会在检测到 prebuild 时
 * 把 target 降为 `{type: none}`，所以 `electron-rebuild` 也是空操作，store 不会被污染。）
 * `font-ls`、`@napi-rs/canvas` 同样是 N-API，天然兼容。
 *
 * 于是本脚本退化为**校验器**：把 CLI 产物里所有 `.node` 交给捆绑 node 逐个 dlopen，
 * 任何 ABI 不匹配 / 文件缺失都会在这里报错退出。`PREBUILD_SOURCES` 保留为空扩展点，
 * 万一将来引入非 N-API 的原生依赖，加一条配置即可恢复自动修复。
 *
 * 幂等：ABI 已匹配时直接返回，不联网。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const cliNodeModules = path.join(repoRoot, "packages/CLI/lib/node_modules");
const binDir = path.resolve(__dirname, "../src-tauri/binaries");

/** 已知可从上游拉取 prebuild 修复的模块。
 *
 * 目前为空——N-API 化之后没有需要这条通道的依赖了。新增条目时注意
 * `target` 要写成 tar 内相对包根目录的路径，且 `file()` 产出的资产名要与
 * 上游 release 实际资产一致（better-sqlite3 v13 已不再发布任何 release 资产）。
 */
const PREBUILD_SOURCES = {};

// ---------------------------------------------------------------- 目标平台

function targetTriple() {
  const { platform, arch } = process;
  if (platform === "win32") {
    return arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  }
  if (platform === "darwin") {
    return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  }
  return arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
}

function nodeBinaryPath() {
  const name =
    process.platform === "win32" ? `node-${targetTriple()}.exe` : `node-${targetTriple()}`;
  return path.join(binDir, name);
}

// ---------------------------------------------------------------- ABI 探测

/**
 * prebuild 命名里的平台 / 架构 token（prebuildify、node-pre-gyp 的通用约定）
 *
 * 为什么需要它：像 better-sqlite3 v13 这种包会把**所有平台**的预编译产物
 * 一起发布（`prebuilds/` 下同时有 win32-x64 / linux-arm64 / darwin-x64 ...）。
 * 非本机平台的 `.node` 拿去 dlopen 必然失败（Windows 上报
 * "is not a valid Win32 application"），不过滤就会把 8 个文件里的 7 个
 * 误报成 ABI 不匹配。
 */
const PLATFORM_TOKENS = ["win32", "darwin", "linux", "linuxmusl", "android", "freebsd", "openbsd"];
const ARCH_TOKENS = [
  "x64",
  "arm64",
  "ia32",
  "arm",
  "armv7l",
  "ppc64",
  "s390x",
  "riscv64",
  "loong64",
];

/** 本机真正可加载的 prebuild 目标。linux 上 glibc / musl 是互斥的 */
function hostPrebuildTargets() {
  const { platform, arch } = process;
  if (platform === "linux") {
    const isGlibc = Boolean(process.report?.getReport?.().header?.glibcVersionRuntime);
    return [isGlibc ? `linux-${arch}` : `linuxmusl-${arch}`];
  }
  return [`${platform}-${arch}`];
}

/**
 * 判断某个 `.node` 是否明显属于其他平台。
 *
 * 只有当文件名里**同时**出现平台 token 和架构 token、且组合起来不是本机目标时才
 * 判为异平台；命名不符合约定的（比如 node-gyp 产出的
 * `build/Release/better_sqlite3.node`）返回 false，照常交给 dlopen 判定——
 * 宁可多探一个，也不要漏掉真正的 ABI 不匹配。
 */
function isForeignPrebuild(file) {
  const tokens = path.basename(file, ".node").split("-");
  const platform = tokens.find((token) => PLATFORM_TOKENS.includes(token));
  const arch = tokens.find((token) => ARCH_TOKENS.includes(token));
  if (!platform || !arch) return false;
  return !hostPrebuildTargets().includes(`${platform}-${arch}`);
}

const readProp = (nodeBin, prop) =>
  execFileSync(nodeBin, ["-p", prop], { encoding: "utf8" }).trim();

/** 把文件清单交给捆绑 node 逐个 dlopen，返回 { 路径: 错误信息|null } */
function probeNodes(nodeBin, files) {
  if (files.length === 0) return {};
  const script = `
    const out = {};
    for (const f of JSON.parse(process.argv[1])) {
      try { process.dlopen({ exports: {} }, f); out[f] = null; }
      catch (e) { out[f] = String(e.message).split("\\n")[0]; }
    }
    process.stdout.write(JSON.stringify(out));
  `;
  return JSON.parse(
    execFileSync(nodeBin, ["-e", script, JSON.stringify(files)], { encoding: "utf8" }),
  );
}

function findNativeModules(root) {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".node"))
    .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name))
    .filter((file) => !isForeignPrebuild(file));
}

/** 已知需要 prebuild 的模块，其目标文件「应当存在」的清单。
 *
 * `PREBUILD_SOURCES` 为空时返回空数组：缺失检查退化为不检查，但 dlopen 探测
 * 仍然会暴露「文件被误删 / 平台不匹配」这类问题。
 */
function expectedTargets() {
  const list = [];
  for (const [pkgName, source] of Object.entries(PREBUILD_SOURCES)) {
    const pkgRoot = path.join(cliNodeModules, pkgName);
    if (!fs.existsSync(path.join(pkgRoot, "package.json"))) continue;
    list.push({ pkgName, pkgRoot, file: path.join(pkgRoot, source.target) });
  }
  return list;
}

// ---------------------------------------------------------------- 路径工具

const NODE_MODULES_MARKER = `${path.sep}node_modules${path.sep}`;

/** 从文件路径定位所在包（支持 @scope/name），返回包名与包根目录 */
function locatePackage(nodeFile) {
  const idx = nodeFile.lastIndexOf(NODE_MODULES_MARKER);
  if (idx === -1) return null;
  const parts = nodeFile.slice(idx + NODE_MODULES_MARKER.length).split(path.sep);
  const pkgLen = parts[0].startsWith("@") ? 2 : 1;
  return {
    pkgName: parts.slice(0, pkgLen).join("/"),
    pkgDir: path.join(
      nodeFile.slice(0, idx + NODE_MODULES_MARKER.length),
      ...parts.slice(0, pkgLen),
    ),
  };
}

// ---------------------------------------------------------------- 下载 / 解压

/**
 * 下载文件。
 *
 * Node 的 fetch（undici）**不读 HTTP(S)_PROXY 环境变量**，在代理环境下会
 * `Connect Timeout`；curl 则遵循系统/环境变量代理设置，因此作为兜底。
 */
async function download(url, dest) {
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  } catch (error) {
    try {
      execFileSync("curl", ["-fsSL", "--retry", "3", "-o", dest, url], { stdio: "pipe" });
    } catch (curlError) {
      throw new Error(
        `下载失败（fetch: ${error.message}；curl: ${curlError.message}）\n  URL: ${url}`,
      );
    }
  }
}

/**
 * 解压 .tar.gz 里的普通文件。
 *
 * 不用系统 `tar`：Git Bash 的 GNU tar 会把 `C:\...` 里的冒号当成远程主机
 * （`Cannot connect to C:`），而 `--force-local` 又是 GNU 专有、bsdtar 不认。
 * prebuild 归档是平铺结构，ustar 格式足够简单，用内置 zlib 直接解即可。
 */
function extractTarGz(tarball, destDir) {
  const archive = zlib.gunzipSync(fs.readFileSync(tarball));
  const cstring = (buf, from, to) => {
    const raw = buf.subarray(from, to).toString("utf8");
    const end = raw.indexOf("\0");
    return end === -1 ? raw : raw.slice(0, end);
  };

  let offset = 0;
  let extracted = 0;

  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break; // 两个全零块 = 归档结束

    const name = cstring(header, 0, 100);
    const size = parseInt(cstring(header, 124, 136).trim(), 8) || 0;
    const typeFlag = header[156];

    offset += 512;

    // 0x30='0' 普通文件；0x00 早期实现的普通文件。其余（目录/pax 头等）跳过
    if (name && (typeFlag === 0x30 || typeFlag === 0x00)) {
      const dest = path.join(destDir, name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, archive.subarray(offset, offset + size));
      extracted += 1;
    }

    offset += Math.ceil(size / 512) * 512;
  }

  if (extracted === 0) throw new Error("归档里没有可解压的文件");
  return extracted;
}

// ---------------------------------------------------------------- 修复

/**
 * 用上游 prebuild 替换某个 .node 文件。
 *
 * 关键：先下载并解压到暂存目录、校验目标文件确实存在，**之后**才动原文件。
 * 直接 rm 原文件再解压的话，一旦解压失败就会留下一个残缺的包。
 */
async function repair(file, { abi, platform, arch }) {
  const located = locatePackage(file);
  if (!located) throw new Error(`无法从路径定位包：${file}`);
  const { pkgName, pkgDir } = located;
  const source = PREBUILD_SOURCES[pkgName];
  if (!source) throw new Error(`没有为 ${pkgName} 配置 prebuild 来源，无法自动修复`);

  const version = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")).version;

  const asset = source.file(version, abi, platform, arch);
  const url = `https://github.com/${source.repo}/releases/download/v${version}/${asset}`;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "native-abi-"));
  const tarball = path.join(tmpDir, asset);
  const stage = path.join(tmpDir, "stage");
  fs.mkdirSync(stage);

  try {
    await download(url, tarball);
    extractTarGz(tarball, stage);

    const staged = path.join(stage, source.target);
    if (!fs.existsSync(staged)) {
      throw new Error(`prebuild 解压后未找到 ${source.target}`);
    }

    // 走到这里才有新文件可用，现在才动原文件。
    // 先删除：它可能是指向 pnpm store 的硬链接，就地覆盖会污染 store。
    fs.rmSync(file, { force: true });
    fs.copyFileSync(staged, file);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  return url;
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const nodeBin = nodeBinaryPath();
  if (!fs.existsSync(nodeBin)) {
    console.error(`[native] 找不到捆绑的 node 运行时：${nodeBin}`);
    console.error(`[native] 请按 .node-version 下载官方 node 到 ${binDir}`);
    process.exit(1);
  }

  const abi = readProp(nodeBin, "process.versions.modules");
  const version = readProp(nodeBin, "process.version");
  const versionFile = fs.readFileSync(path.join(repoRoot, ".node-version"), "utf8").trim();

  console.log(`[native] 捆绑 node: ${version} (ABI ${abi})`);
  if (versionFile !== version) {
    console.warn(`[native] 警告：.node-version 是 ${versionFile}，与捆绑 node ${version} 不一致`);
  }

  const files = findNativeModules(cliNodeModules);
  if (files.length === 0) {
    console.log("[native] CLI 产物里没有原生模块，跳过");
    return;
  }

  // 收集问题：缺失文件 + ABI 不匹配。缺失也要查，否则修坏了会被静默放过。
  const problems = [];
  for (const { file } of expectedTargets()) {
    if (!fs.existsSync(file)) problems.push({ file, reason: "文件缺失" });
  }

  const present = files.filter((file) => fs.existsSync(file));
  for (const [file, error] of Object.entries(probeNodes(nodeBin, present))) {
    if (error !== null) problems.push({ file, reason: error });
  }

  if (problems.length === 0) {
    console.log(`[native] ${files.length} 个原生模块全部与捆绑 node 兼容 ✓`);
    return;
  }

  console.log(`[native] 发现 ${problems.length} 个原生模块与捆绑 node 不兼容：`);
  for (const { file, reason } of problems) {
    console.log(`[native]   ${locatePackage(file)?.pkgName ?? file}: ${reason.slice(0, 110)}`);
  }

  // 只有配了 prebuild 来源的才尝试自动修复，其余原样上报
  const repairable = problems.filter(({ file }) => {
    const pkgName = locatePackage(file)?.pkgName;
    return Boolean(pkgName && PREBUILD_SOURCES[pkgName]);
  });

  if (repairable.length === 0) {
    console.error("[native] 没有可用的自动修复来源（PREBUILD_SOURCES 为空）。");
    console.error(
      "[native] 现有依赖都是 N-API，本不该出现 ABI 不匹配——请检查该模块的 prebuilds/ 是否齐全、平台/架构是否匹配。",
    );
    process.exit(1);
  }

  console.log(`[native] 尝试自动修复 ${repairable.length} 个：`);
  const { platform, arch } = process;
  for (const { file } of repairable) {
    const url = await repair(file, { abi, platform, arch });
    console.log(`[native]   ↓ 已替换 ${locatePackage(file)?.pkgName ?? file}：${url}`);
  }

  // 复验
  const remaining = [];
  for (const { file } of expectedTargets()) {
    if (!fs.existsSync(file)) remaining.push({ file, reason: "文件仍缺失" });
  }
  const after = findNativeModules(cliNodeModules);
  for (const [file, error] of Object.entries(probeNodes(nodeBin, after))) {
    if (error !== null) remaining.push({ file, reason: error });
  }

  if (remaining.length > 0) {
    console.error("[native] 修复后仍有问题：");
    for (const { file, reason } of remaining) console.error(`[native]   ${file}: ${reason}`);
    process.exit(1);
  }
  console.log(`[native] 修复完成，${after.length} 个原生模块全部可用 ✓`);
}

main().catch((error) => {
  console.error("[native] 失败：", error.message);
  process.exit(1);
});
