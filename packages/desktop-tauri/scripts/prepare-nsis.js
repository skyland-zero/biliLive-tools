/**
 * 为 NSIS 安装包准备「预压 payload」和「最终 NSIS 模板」。
 *
 * ## 背景
 *
 * Tauri 默认把 `bundle.resources` + `bundle.externalBin` 的每个文件单独 `File` 进一个
 * `/SOLID lzma` 数据块。payload 约 500MB，安装时 NSIS 用自己的**单线程 LZMA1** 解码
 * （实测 ~25MB/s），且 solid 模式下会先解到临时文件再拷贝，因此装得很慢。
 *
 * 这里照搬 electron-builder 的做法：把 payload 用 `7za -mx=9`（LZMA2，多线程）离线压成一个
 * `payload.7z`，模板里 `SetCompress off` 塞进安装包、运行时用 `nsis7z` 插件解压。
 * 实测 521MB payload：安装包 167MB→150MB，安装耗时 20.7s→8.7s。
 *
 * ## 这个脚本做三件事
 *
 * 1. 按 `tauri.conf.json` 的 `bundle.resources` / `bundle.externalBin` 收集 payload 内容
 *    （单一数据源，避免两处清单不一致），过滤掉运行时用不到的文件，拷到 staging 目录；
 * 2. 用 7za 压成 `payload.7z`（mtime 未变化时跳过，避免每次 build 都重压 500MB）；
 * 3. 把 `src-tauri/nsis/installer.nsi` 里的占位符替换成绝对路径，输出
 *    `src-tauri/nsis/installer.generated.nsi`（tauri.conf.json 里 nsis.template 指向它）。
 *
 * 由 `tauri.conf.json` 的 `build.beforeBundleCommand` 调用，`tauri build` / `tauri bundle` 都会先跑。
 * 非 Windows 平台直接跳过（`bundle.targets` 只有 nsis）。
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(packageDir, "../..");
const srcTauriDir = path.join(packageDir, "src-tauri");

const argv = process.argv.slice(2);
const force = argv.includes("--force");

/**
 * payload 里永远用不到的文件，直接不打进安装包。
 *
 * 这些文件在源头（`scripts/install-bin.js`、`packages/CLI/scripts/copy_module.js`）
 * 已经不再产生了，这里再过滤一次，防止本地残留的旧目录把它们带进来。
 */
const EXCLUDED_FILE = [/\.pdb$/i, /\.xml$/i, /\.md$/i, /\.log$/i];
const EXCLUDED_DIR = new Set(["logs"]);

/** 许可证文件不能过滤（部分包的许可证就叫 LICENSE.md） */
const LICENSE_FILE = /^(licen[cs]e|copying|notice)/i;

// 日志
const log = (message) => console.log(`[nsis] ${message}`);
const human = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;

function fail(message) {
  console.error(`[nsis] ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------- 目标平台

/**
 * `packages/CLI/lib` 的 `node_modules` 不是 rollup 产出的，而是 `build` 脚本最后调的
 * `scripts/copy_module.js` 拷过去的。少了它，装完 sidecar 起来就会 MODULE_NOT_FOUND。
 * 这里提前拦住，避免打出一个装完打不开的安装包。
 */
function assertCliBundle() {
  const libDir = path.resolve(packageDir, "../CLI/lib");
  const missing = ["index.cjs", "node_modules"].filter(
    (name) => !fs.existsSync(path.join(libDir, name)),
  );
  if (missing.length > 0) {
    fail(
      `CLI 产物不完整：${libDir} 缺少 ${missing.join("、")}\n` +
        `      先运行 \`pnpm run build:cli\``,
    );
  }
}

/** 目标三元组：优先用 tauri CLI 注入的 TAURI_ENV_TARGET_TRIPLE，否则用宿主平台 */
function resolveTargetTriple() {
  if (process.env.TAURI_ENV_TARGET_TRIPLE) return process.env.TAURI_ENV_TARGET_TRIPLE;
  const host = `${process.platform === "win32" ? "pc" : "unknown"}-${process.platform}`;
  if (process.platform === "win32") {
    return process.arch === "arm64"
      ? "aarch64-pc-windows-msvc"
      : process.arch === "ia32"
        ? "i686-pc-windows-msvc"
        : "x86_64-pc-windows-msvc";
  }
  return host;
}

/** cargo 的 target 目录（`CARGO_TARGET_DIR` 优先），payload 的中间产物都放在里面 */
function resolveTargetDir() {
  const configured = process.env.CARGO_TARGET_DIR;
  if (!configured) return path.join(srcTauriDir, "target");
  return path.isAbsolute(configured) ? configured : path.resolve(repoRoot, configured);
}

// ---------------------------------------------------------------- payload 清单

/**
 * 从 tauri.conf.json 读取 payload 清单。
 *
 * - `bundle.resources`：`{ 源路径: 安装目录内的相对路径 }`
 * - `bundle.externalBin`：源文件名是 `<name>-<target-triple><ext>`，装进安装目录后叫 `<name><ext>`
 */
function collectEntries() {
  assertCliBundle();
  const config = JSON.parse(fs.readFileSync(path.join(srcTauriDir, "tauri.conf.json"), "utf8"));
  const bundle = config.bundle ?? {};
  const entries = [];

  for (const [from, to] of Object.entries(bundle.resources ?? {})) {
    const src = path.resolve(srcTauriDir, from);
    if (!fs.existsSync(src)) {
      fail(`bundle.resources 里的路径不存在：${from}（${src}）\n      先运行 pnpm run install:bin`);
    }
    const dest = String(to).replace(/[\\/]+$/, "");
    entries.push({ src, dest, isDir: fs.statSync(src).isDirectory() });
  }

  const triple = resolveTargetTriple();
  const ext = process.platform === "win32" ? ".exe" : "";
  for (const bin of bundle.externalBin ?? []) {
    const resolved = path.resolve(srcTauriDir, bin);
    const name = path.basename(resolved);
    const src = path.join(path.dirname(resolved), `${name}-${triple}${ext}`);
    if (!fs.existsSync(src)) {
      fail(`externalBin 对应的产物不存在：${src}\n      先运行 pnpm run bin:ensure`);
    }
    entries.push({ src, dest: `${name}${ext}`, isDir: false });
  }

  if (entries.length === 0)
    fail("tauri.conf.json 里没有配置 bundle.resources / bundle.externalBin");
  return entries;
}

// ---------------------------------------------------------------- staging

function shouldSkip(name) {
  if (LICENSE_FILE.test(name)) return null;
  if (EXCLUDED_DIR.has(name)) return "目录";
  if (EXCLUDED_FILE.some((pattern) => pattern.test(name))) return "无用文件";
  return null;
}

/** 按 `bundle.resources` 的映射把 payload 拷进 staging 目录，返回值是过滤统计 */
function stageEntries(entries, stageDir) {
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  const skipped = { count: 0, bytes: 0 };

  for (const entry of entries) {
    if (!entry.isDir) {
      const target = path.join(stageDir, entry.dest);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(entry.src, target);
      continue;
    }
    fs.cpSync(entry.src, path.join(stageDir, entry.dest), {
      recursive: true,
      filter: (source) => {
        const name = path.basename(source);
        const reason = shouldSkip(name);
        if (reason) {
          skipped.count += 1;
          skipped.bytes += statSize(source);
          return false;
        }
        return true;
      },
    });
  }
  return skipped;
}

/** 用 lstat，不跟随符号链接，避免意外的循环 */
function statSize(target) {
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink()) return 0;
  if (stat.isFile()) return stat.size;
  let total = 0;
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    total += statSize(path.join(target, entry.name));
  }
  return total;
}

// ---------------------------------------------------------------- 打包

function resolve7za() {
  if (process.env.BILILIVE_7ZA) return process.env.BILILIVE_7ZA;
  return require("7zip-bin").path7za ?? require("7zip-bin").path7z;
}

/** payload 变旧时才重新压（输入目录 mtime + tauri.conf.json mtime 都比产物新时跳过） */
function isUpToDate(outputFile, inputs) {
  const stat = fs.statSync(outputFile, { throwIfNoEntry: false });
  if (!stat) return false;
  return inputs.every((input) => newestMtime(input) <= stat.mtimeMs);
}

function newestMtime(target) {
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink()) return 0;
  if (stat.isFile()) return stat.mtimeMs;
  let newest = stat.mtimeMs;
  for (const entry of fs.readdirSync(target)) {
    newest = Math.max(newest, newestMtime(path.join(target, entry)));
  }
  return newest;
}

function buildArchive(stageDir, outputFile) {
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.rmSync(outputFile, { force: true });
  const sevenZip = resolve7za();
  const args = [
    "a",
    "-t7z",
    "-mx=9", // 与 electron-builder 一致；解压是 LZMA2 多线程
    "-mmt=on",
    "-mtc=off", // 不存创建时间，保证同样输入产出同样归档
    "-mta=off",
    "-bso0",
    "-bsp0",
    outputFile,
    ...fs.readdirSync(stageDir), // 用相对名 -> 归档内就是安装目录的布局
  ];
  log(`压缩 payload：${sevenZip}`);
  const started = Date.now();
  try {
    execFileSync(sevenZip, args, { cwd: stageDir, stdio: ["ignore", "inherit", "inherit"] });
  } catch (error) {
    fail(`7za 压缩失败：${error.message}`);
  }
  log(
    `payload 完成：${human(fs.statSync(outputFile).size)}，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
}

// ---------------------------------------------------------------- 模板

/**
 * 把 installer.nsi 里的占位符换成绝对路径。
 *
 * 为什么不直接把 payload 放 staging 目录（`target/<profile>/nsis/<arch>/`）里用相对路径？
 * 因为 tauri-bundler 在渲染模板前会 `remove_dir_all` 掉那个目录，之后没有 hook 可插入。
 * 所以模板只能靠绝对路径找到 payload；生成物是机器相关的，不进版本库。
 */
function generateTemplate(payloadFile) {
  const source = path.join(srcTauriDir, "nsis", "installer.nsi");
  const output = path.join(srcTauriDir, "nsis", "installer.generated.nsi");
  const pluginDir = path.join(srcTauriDir, "nsis", "plugins", "x86-unicode");
  if (!fs.existsSync(path.join(pluginDir, "nsis7z.dll"))) {
    fail(`缺少 nsis7z 插件：${path.join(pluginDir, "nsis7z.dll")}`);
  }

  const replaced = fs
    .readFileSync(source, "utf8")
    .replaceAll("@BILILIVE_PAYLOAD_7Z@", payloadFile)
    .replaceAll("@BILILIVE_NSIS7Z_DIR@", pluginDir);
  // 不带 BOM：tauri-bundler 渲染后自己会写成 UTF-8 with BOM
  fs.writeFileSync(output, replaced);
  log(`已生成 ${path.relative(repoRoot, output)}`);
}

// ---------------------------------------------------------------- main

function main() {
  if (process.platform !== "win32") {
    log("非 Windows 平台，跳过");
    return;
  }

  const entries = collectEntries();
  const targetDir = resolveTargetDir();
  const workDir = path.join(targetDir, "nsis-payload");
  const stageDir = path.join(workDir, "stage");
  const payloadFile = path.join(workDir, "payload.7z");

  const inputs = [...entries.map((entry) => entry.src), path.join(srcTauriDir, "tauri.conf.json")];
  if (force || !isUpToDate(payloadFile, inputs)) {
    const skipped = stageEntries(entries, stageDir);
    const staged = fs.readdirSync(stageDir);
    log(`payload 内容：${staged.join(", ")}`);
    if (skipped.count > 0) {
      log(`已过滤 ${skipped.count} 个无用文件（${human(skipped.bytes)}）`);
    }
    buildArchive(stageDir, payloadFile);
    fs.rmSync(stageDir, { recursive: true, force: true });
  } else {
    log(`payload 已是最新：${human(fs.statSync(payloadFile).size)}，跳过压缩`);
  }

  generateTemplate(payloadFile);
}

main();
