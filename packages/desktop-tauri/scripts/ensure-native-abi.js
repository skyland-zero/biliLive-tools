/**
 * 确保 CLI 产物里的原生模块与「捆绑的 node 运行时」ABI 匹配。
 *
 * ## 为什么需要这一步
 *
 * sidecar 执行的是 `src-tauri/binaries/node-<target-triple>`，**不是开发机上的 node**。
 * 而 `packages/CLI/scripts/copy_module.js` 是从 pnpm store 直接拷贝原生模块的，那份产物
 * 已被 `packages/app` 的 `postinstall: electron-builder install-app-deps` 重建为
 * **Electron ABI**（NODE_MODULE_VERSION 145）——任何官方 Node 都加载不了它。
 *
 * 症状：安装后打开一直停在「正在启动…」，`sidecar.log` 里是
 * `ERR_DLOPEN_FAILED ... was compiled against a different Node.js version`。
 *
 * 因此这里按捆绑 node 的 ABI，从上游拉取对应 prebuild 覆盖。
 * N-API 模块（`@napi-rs/canvas`、`font-ls`）ABI 稳定，天然通过，无需处理。
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

/** 已知可从上游拉取 prebuild 修复的模块 */
const PREBUILD_SOURCES = {
  "better-sqlite3": {
    repo: "WiseLibs/better-sqlite3",
    file: (version, abi, platform, arch) =>
      `better-sqlite3-v${version}-node-v${abi}-${platform}-${arch}.tar.gz`,
    /** tar 内相对包根目录的路径 */
    target: "build/Release/better_sqlite3.node",
  },
};

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
    .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name));
}

/** 已知需要 prebuild 的模块，其目标文件「应当存在」的清单 */
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
  for (const { pkgName, file } of expectedTargets()) {
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

  console.log(`[native] 发现 ${problems.length} 个问题，尝试修复：`);
  for (const { file, reason } of problems) {
    console.log(`[native]   ${locatePackage(file)?.pkgName ?? file}: ${reason.slice(0, 110)}`);
  }

  const { platform, arch } = process;
  for (const { file } of problems) {
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
