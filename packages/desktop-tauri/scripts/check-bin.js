/**
 * 外部工具（ffmpeg / BililiveRecorder.Cli 等）检查脚本。
 *
 * 这些二进制由根目录的 `pnpm run install:bin` 下载到 `packages/app/resources/bin`，
 * 与 Electron 版共用同一份产物。tauri.conf.json 会把该目录打进安装包
 * （`bundle.resources`），因此目录必须存在，否则 Rust 侧构建脚本会直接报错。
 *
 * - 默认（dev）：目录不存在时创建并给出提示，缺少工具只警告，不阻塞界面开发
 * - --strict（build）：缺少必要工具时失败，避免打出缺少外部工具的安装包
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const strict = process.argv.includes("--strict");
const binDir = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../app/resources/bin",
);
const ext = process.platform === "win32" ? ".exe" : "";
/** 录制/转码必需的工具 */
const requiredTools = ["ffmpeg", "ffprobe", "mesio", "BililiveRecorder.Cli", "DanmakuFactory"].map(
  (name) => `${name}${ext}`,
);
/** 可选工具，部分平台 install-bin.js 不提供下载 */
const optionalTools = [`audiowaveform${ext}`];

const hint = "请运行 pnpm run install:bin 下载（或设置 BILILIVE_TAURI_BIN_DIR 指向已有目录）";

if (!fs.existsSync(binDir)) {
  if (strict) {
    console.error(`[bin] 外部工具目录不存在：${binDir}\n[bin] ${hint}`);
    process.exit(1);
  }
  fs.mkdirSync(binDir, { recursive: true });
  console.warn(`[bin] 外部工具目录不存在，已创建：${binDir}\n[bin] ${hint}`);
}

const missingRequired = requiredTools.filter((tool) => !fs.existsSync(path.join(binDir, tool)));
const missingOptional = optionalTools.filter((tool) => !fs.existsSync(path.join(binDir, tool)));

if (missingRequired.length > 0) {
  const message = `[bin] 缺少外部工具：${missingRequired.join(", ")}（目录 ${binDir}）\n[bin] ${hint}`;
  if (strict) {
    console.error(message);
    process.exit(1);
  }
  console.warn(message);
}
if (missingOptional.length > 0) {
  console.warn(
    `[bin] 缺少可选工具：${missingOptional.join(", ")}（目录 ${binDir}），相关功能不可用`,
  );
}
