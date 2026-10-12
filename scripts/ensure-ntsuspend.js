/**
 * 补齐 `ntsuspend` 的原生模块。
 *
 * ## 为什么需要这个脚本
 *
 * `ntsuspend` 的 npm 包里**没有**原生二进制，靠它自己的 `postinstall` 从 GitHub Releases
 * 下载 `win32-<arch>_lib.node`（见 `node_modules/ntsuspend/install.cjs`）。
 * 本仓库用 pnpm，安装脚本不一定会被执行；即使执行了，失败也只是它自己 `console.error`，
 * pnpm 不会报错。
 *
 * 后果：`packages/app` 和 `packages/CLI` 的 `node_modules/ntsuspend` 里都只有 JS，
 * 打出来的安装包自然也缺这个 `.node`，而 `lib.cjs` 是无条件 `require` 它的：
 *
 * ```js
 * if (process.platform === 'win32') {
 *   const ntsuspend = require(`./win32-${process.arch}_lib.node`); // <- MODULE_NOT_FOUND
 * }
 * ```
 *
 * 表现为 packaged 版点「暂停任务 / 继续任务」直接抛错（`packages/shared/src/task/task.ts`
 * 的调用点是裸调用，没有 try/catch）。
 *
 * ## 行为
 *
 * 按 ntsuspend 自己的规则下载并写入各个使用方的包目录。幂等：文件已存在就直接返回，
 * 非 Windows 平台直接跳过。默认失败只告警；加 `--strict`（CI 自动启用）则失败退出。
 *
 * ```bash
 * pnpm run ensure:ntsuspend            # 手动补齐
 * pnpm run ensure:ntsuspend --strict   # 失败即报错（CI 用）
 * ```
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const GITHUB_REPO = "https://github.com/FedericoCarboni/node-ntsuspend";

/** 会把这个包打进产物的使用方（相对仓库根目录） */
const CONSUMERS = ["packages/app", "packages/CLI"];

const strict = process.argv.includes("--strict") || Boolean(process.env.CI);
const log = (message) => console.log(`[ntsuspend] ${message}`);

function done(message) {
  log(message);
  process.exit(0);
}

function fail(message) {
  if (strict) {
    console.error(`[ntsuspend] ${message}`);
    process.exit(1);
  }
  console.warn(`[ntsuspend] ${message}`);
  process.exit(0);
}

/** 目标文件的绝对路径；包不存在时返回 null */
function resolveBinaryPath(consumerDir, arch) {
  const require = createRequire(path.join(repoRoot, consumerDir, "package.json"));
  let entryPath;
  try {
    // ntsuspend 的 exports 里没有 "./package.json"，只能解析包入口再取目录
    entryPath = require.resolve("ntsuspend");
  } catch {
    return null;
  }
  const packageDir = path.dirname(entryPath);
  return { packageDir, binary: path.join(packageDir, `win32-${arch}_lib.node`) };
}

async function main() {
  if (process.platform !== "win32") {
    done(`非 Windows 平台，跳过（当前 ${process.platform}）`);
  }
  if (!["x64", "ia32"].includes(process.arch)) {
    done(`不支持的架构 ${process.arch}，跳过`);
  }

  // ntsuspend 只对 win32 x64/ia32 生效；两个使用方解析到的是同一个 pnpm store 目录，
  // 但这里仍逐个检查，避免以后依赖结构变化时漏掉。
  const targets = new Map();
  for (const consumer of CONSUMERS) {
    const resolved = resolveBinaryPath(consumer, process.arch);
    if (!resolved) {
      log(`${consumer} 未安装 ntsuspend，跳过`);
      continue;
    }
    targets.set(resolved.binary, resolved);
  }

  const missing = [...targets.values()].filter(({ binary }) => !fs.existsSync(binary));
  if (missing.length === 0) {
    done("原生模块已就位");
  }

  // 版本从包自身的 package.json 取，和 install.cjs 的规则保持一致
  const { packageDir } = missing[0];
  const { version } = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
  const filename = `win32-${process.arch}_lib.node`;
  const url = `${GITHUB_REPO}/releases/download/v${version}/${filename}`;

  const { downloadWithProxy } = await import("./lib/download.js");

  for (const { packageDir: dir, binary } of missing) {
    log(`下载 ${url} -> ${binary}`);
    try {
      await downloadWithProxy(url, dir, { extract: false });
    } catch (error) {
      fail(`下载失败：${error.message}\n      可手动下载后放到 ${binary}`);
    }
    if (!fs.existsSync(binary)) {
      fail(`下载完成但文件不存在：${binary}`);
    }
  }

  log(`已补齐 ${missing.length} 处 ntsuspend 原生模块`);
}

main();
