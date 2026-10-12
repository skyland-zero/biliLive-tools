import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// TODO:显然其他类型打包还有问题
const cli_node_modules = path.resolve(__dirname, "../lib/node_modules");
const pnpm_node_modules = path.resolve(__dirname, "../../../node_modules");
const cli_own_node_modules = path.resolve(__dirname, "../node_modules");

const require = createRequire(import.meta.url);

/**
 * 在 pnpm 严格模式下，包可能不在根 node_modules 下，
 * 需要从多个候选路径中查找实际存在的路径
 */
function resolvePackagePath(packageName) {
  // 优先使用 require.resolve 定位包的实际入口，再推导包的根目录
  try {
    const resolved = require.resolve(packageName, { paths: [__dirname + "/.."] });
    // 从解析到的文件路径向上查找包的根目录（包含 package.json 的目录）
    let dir = path.dirname(resolved);
    while (dir !== path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, "package.json"))) {
        return dir;
      }
      dir = path.dirname(dir);
    }
  } catch {
    // require.resolve 失败，回退到候选路径
  }

  // 回退：依次检查候选路径
  const candidates = [pnpm_node_modules, cli_own_node_modules];
  for (const base of candidates) {
    const candidate = path.join(base, packageName);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // pnpm 严格模式下，间接依赖可能只在 .pnpm 存储中
  // 在 .pnpm 目录下搜索包含该包名的目录
  const pnpmDir = path.join(pnpm_node_modules, ".pnpm");
  if (fs.existsSync(pnpmDir)) {
    const scopedName = packageName.replace("/", "+");
    try {
      for (const entry of fs.readdirSync(pnpmDir)) {
        if (entry.startsWith(scopedName) || entry.startsWith(packageName)) {
          const candidate = path.join(pnpmDir, entry, "node_modules", packageName);
          if (fs.existsSync(candidate)) {
            return candidate;
          }
        }
      }
    } catch {
      console.log("未找到该包的 .pnpm 目录");
    }
  }

  return null;
}

function safeCpSync(packageName, options = {}) {
  const src = resolvePackagePath(packageName);
  if (!src) {
    console.warn(`跳过复制 ${packageName}：未找到该包`);
    return;
  }
  const dest = path.join(cli_node_modules, packageName);
  fs.cpSync(src, dest, { recursive: true, ...options });

  // 对于作用域包（如 @napi-rs），pnpm 严格模式下 optionalDependencies
  // 可能不在 node_modules/@scope/ 目录下，而是存在于 .pnpm 存储中，需要额外搜索并复制
  if (packageName.startsWith("@")) {
    const scopePrefix = packageName + "+";
    const pnpmDir = path.join(pnpm_node_modules, ".pnpm");
    if (fs.existsSync(pnpmDir)) {
      try {
        for (const entry of fs.readdirSync(pnpmDir)) {
          if (entry.startsWith(scopePrefix)) {
            const pkgPath = path.join(pnpmDir, entry, "node_modules", packageName);
            if (fs.existsSync(pkgPath)) {
              for (const subPkg of fs.readdirSync(pkgPath)) {
                const subSrc = path.join(pkgPath, subPkg);
                const subDest = path.join(dest, subPkg);
                if (!fs.existsSync(subDest)) {
                  fs.cpSync(subSrc, subDest, {
                    recursive: true,
                    dereference: options.dereference ?? false,
                  });
                }
              }
            }
          }
        }
      } catch {
        console.log(`未找到 .pnpm 目录中的 ${packageName} 相关包`);
      }
    }
  }
}

function main() {
  // 找到@napi-rs相关包，复制到cli_node_modules,这个路径可能不存在，不存在则创建
  if (!fs.existsSync(cli_node_modules)) {
    fs.mkdirSync(cli_node_modules);
  }
  // 复制@napi-rs相关文件，pnpm严格模式下@napi-rs目录内的子包是符号链接，需要dereference解引用复制实际文件
  safeCpSync("@napi-rs", { dereference: true });
  // 复制ntsuspend相关文件，
  safeCpSync("ntsuspend");
  // 复制font-list相关文件，
  safeCpSync("font-ls");
  // 复制better-sqlite3相关文件，
  safeCpSync("better-sqlite3");
  // 复制music-segment-detector相关文件，
  safeCpSync("music-segment-detector");
  // 复制meyda相关文件，
  safeCpSync("meyda");
  // 复制shazamio-core相关文件，
  safeCpSync("shazamio-core");
  safeCpSync("file-uri-to-path");
  safeCpSync("bindings");

  pruneUnusedFiles();
  warnMissingNtSuspendBinary();
}

// ---------------------------------------------------------------- 打包剪裁

/**
 * `lib/node_modules` 会被整目录打进安装包（Tauri 侧压进 payload.7z，Electron 侧进 asar），
 * 而 pnpm store 里是完整的 npm 包——包含只在编译期用得到的源码、MSVC 中间产物、
 * 给浏览器/TypeScript 用的产物。这里按包删掉运行时不需要的部分。
 *
 * 规则里不带 `*` 的项：删掉该相对路径（目录递归删）；带 `*` 的只匹配同层文件名。
 * 实测可省约 25MB（79MB -> 54MB）。
 */
const PRUNE_RULES = {
  "better-sqlite3": [
    // sqlite3.c / sqlite3.h 合并源码（9.5MB），只在编译 build/Release/better_sqlite3.node 时用
    "deps",
    // C++ 源码，同样只在编译时用
    "src",
    "binding.gyp",
    "README.md",
    "build/Release/.forge-meta",
  ],
  "font-ls": [
    "src",
    "test",
    ".github",
    ".node-version",
    "CHANGELOG.md",
    "binding.gyp",
    "build/binding.sln",
    "build/config.gypi",
    "build/*.vcxproj",
    "build/*.vcxproj.filters",
    // 运行时只需要 build/Release/fontmanager.node，其余全是 MSVC 产物
    "build/Release/obj",
    "build/Release/*.pdb",
    "build/Release/*.iobj",
    "build/Release/*.ipdb",
    "build/Release/*.lib",
    "build/Release/*.exp",
  ],
  meyda: [
    "src",
    "bin",
    "tsconfig.json",
    "rollup.config.mjs",
    "README.md",
    // main 指向 dist/node/main.js；web 是浏览器入口，esm 只给 types 字段用
    "dist/web",
    "dist/esm",
  ],
  // main 指向 node/；web/ 是浏览器用的 wasm 版
  "shazamio-core": ["web"],
  "file-uri-to-path": ["test", "History.md"],
};

/** 规则匹配：`a/b` 及其子路径，或 `a/*.ext` 这种同层通配 */
function matchRule(relativePath, rule) {
  const target = relativePath.replaceAll("\\", "/");
  const starIndex = rule.indexOf("*");
  if (starIndex < 0) {
    return target === rule || target.startsWith(`${rule}/`);
  }
  const dir = rule.slice(0, rule.lastIndexOf("/", starIndex) + 1);
  if (!target.startsWith(dir)) {
    return false;
  }
  const file = target.slice(dir.length);
  if (file.includes("/")) {
    return false;
  }
  const [prefix, suffix] = rule.slice(dir.length).split("*");
  return file.startsWith(prefix) && file.endsWith(suffix);
}

function pathSize(target) {
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink()) {
    return 0;
  }
  if (stat.isFile()) {
    return stat.size;
  }
  if (!stat.isDirectory()) {
    return 0;
  }
  return fs.readdirSync(target).reduce((sum, name) => sum + pathSize(path.join(target, name)), 0);
}

function prunePackage(packageDir, rules) {
  let saved = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (rules.some((rule) => matchRule(path.relative(packageDir, full), rule))) {
        saved += pathSize(full);
        fs.rmSync(full, { recursive: true, force: true });
        continue;
      }
      if (entry.isDirectory()) {
        walk(full);
      }
    }
  };
  walk(packageDir);
  return saved;
}

function pruneUnusedFiles() {
  let saved = 0;
  for (const [packageName, rules] of Object.entries(PRUNE_RULES)) {
    const packageDir = path.join(cli_node_modules, packageName);
    if (fs.existsSync(packageDir)) {
      saved += prunePackage(packageDir, rules);
    }
  }
  console.log(`剪裁运行时用不到的文件：${(saved / 1024 / 1024).toFixed(1)}MB`);
}

/**
 * ntsuspend 的原生模块不在 npm 包里，靠它自己的 postinstall 从 GitHub Releases 下载，
 * 而本仓库用 pnpm，安装脚本不一定会执行。缺少时 packaged 版「暂停/继续任务」会直接抛错，
 * 这里提前提醒（真正的修复在仓库根目录 scripts/ensure-ntsuspend.js）。
 */
function warnMissingNtSuspendBinary() {
  if (process.platform !== "win32") {
    return;
  }
  const binary = path.join(cli_node_modules, "ntsuspend", `win32-${process.arch}_lib.node`);
  if (!fs.existsSync(binary)) {
    console.warn(
      `警告：缺少 ${binary}\n` +
        `      打包版将无法暂停/继续任务，请先运行 \`pnpm run ensure:ntsuspend\``,
    );
  }
}

main();
