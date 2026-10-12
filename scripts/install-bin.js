import fs from "fs-extra";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SingleBar } from "cli-progress";
import JSZip from "jszip";

import { downloadWithProxy } from "./lib/download.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 这些文件在运行时不读：
 *   *.pdb  .NET 调试符号（BililiveRecorder 带了一堆）
 *   *.xml  .NET 文档注释，只给 IDE 提示用
 *   *.md   说明文档
 * 目录会被整包打进安装包（Tauri 的 payload.7z / Electron 的 asar），实测能省 ~2.7MB。
 */
const UNUSED_FILE_PATTERNS = [/\.pdb$/i, /\.xml$/i, /\.md$/i];

/** 许可证文件不能删（部分包的许可证就叫 LICENSE.md） */
const LICENSE_FILE = /^(licen[cs]e|copying|notice)/i;

const isUnusedFile = (filename) =>
  !LICENSE_FILE.test(filename) && UNUSED_FILE_PATTERNS.some((pattern) => pattern.test(filename));

async function unzip(zipFile, destination) {
  const zip = new JSZip();
  const data = await zip.loadAsync(fs.readFileSync(zipFile));
  let skipped = 0;
  await Promise.all(
    Object.keys(data.files).map(async (filename) => {
      const file = data.files[filename];
      if (!file.dir) {
        if (isUnusedFile(filename)) {
          skipped += 1;
          return;
        }
        const content = await file.async("nodebuffer");
        const filePath = path.join(destination, filename);
        fs.ensureDirSync(path.dirname(filePath));
        fs.writeFileSync(filePath, content);
        if (process.platform === "linux" || process.platform === "darwin") {
          fs.chmodSync(filePath, 0o755);
        }
      }
    }),
  );
  console.log(skipped > 0 ? `解压成功（跳过 ${skipped} 个运行时不需要的文件）` : "解压成功");
}

/**
 * 清掉历史遗留的 *.pdb / *.xml / *.md。
 *
 * 这些文件以前会被解压到 resources/bin 里，然后整目录打进安装包；
 * 上面的 unzip 已经不再写入它们了，但本地已经存在的旧目录需要清一次。
 */
function removeUnusedBinFiles() {
  const binDir = path.resolve(__dirname, "../packages/app/resources/bin");
  if (!fs.existsSync(binDir)) {
    return;
  }
  let removed = 0;
  for (const name of fs.readdirSync(binDir)) {
    const file = path.join(binDir, name);
    if (fs.statSync(file).isFile() && isUnusedFile(name)) {
      removed += fs.statSync(file).size;
      fs.rmSync(file);
    }
  }
  if (removed > 0) {
    console.log(`清理 resources/bin 里用不到的文件：${(removed / 1024 / 1024).toFixed(1)}MB`);
  }
}

async function downloadFile(url, desc, options = {}) {
  const downloader = downloadWithProxy(url, desc, options);
  const progressBar = new SingleBar({
    format: "下载进度 |{bar}| {percentage}% | ETA: {eta}s",
    barCompleteChar: "\u2588",
    barIncompleteChar: "\u2591",
    hideCursor: true,
  });
  progressBar.start(100, 0);

  downloader.on("downloadProgress", (progress) => {
    progressBar.update(progress.percent * 100);
  });
  downloader.on("error", (err) => {
    console.error(err);
  });
  downloader.on("end", () => {
    console.log("\n下载成功");
  });
  await downloader;
  progressBar.stop();
}

/**
 * 下载 mesio 工具
 */
async function downloadMesio() {
  // https://github.com/hua0512/rust-srec
  const version = "mesio-v0.5.0";
  const mesioAssets = {
    "win32-x64": "mesio-x86_64-pc-windows-msvc.exe",
    "darwin-arm64": "mesio-aarch64-apple-darwin",
    "darwin-x64": "mesio-x86_64-apple-darwin",
    "linux-arm64": "mesio-aarch64-unknown-linux-musl",
    "linux-x64": "mesio-x86_64-unknown-linux-musl",
  };
  const target = `${process.platform}-${process.arch}`;
  const assetName = mesioAssets[target];

  if (!assetName) {
    throw new Error(`mesio ${version} 暂不支持平台: ${target}`);
  }

  const mesioUrl = `https://github.com/hua0512/rust-srec/releases/download/${version}/${assetName}`;
  await downloadFile(mesioUrl, "packages/app/resources/bin", {
    filename: process.platform === "win32" ? "mesio.exe" : "mesio",
  });
  // 添加执行权限
  if (process.platform === "linux" || process.platform === "darwin") {
    fs.chmodSync("packages/app/resources/bin/mesio", 0o755);
  }
}

/**
 * 下载 BililiveRecorder 工具
 */
async function downloadBililiveRecorder() {
  // https://github.com/renmu123/BililiveRecorder/releases
  const platforms = {
    win32: "win",
    darwin: "osx",
  };
  const platform = platforms[process.platform] ?? process.platform;
  const arch = process.arch;
  const filename = `BililiveRecorder-CLI-${platform}-${arch}.zip`;
  let url = `https://github.com/renmu123/BililiveRecorder/releases/download/v3.4.0/${filename}`;

  await downloadFile(url, ".");
  await unzip(filename, "packages/app/resources/bin");

  // 添加执行权限
  if (process.platform === "linux" || process.platform === "darwin") {
    fs.chmodSync("packages/app/resources/bin/BililiveRecorder.Cli", 0o755);
  }
}

/**
 * 下载 audiowaveform 工具
 */
async function downloadAudioWaveform() {
  const version = "1.10.2";
  // https://github.com/bbc/audiowaveform
  const platforms = {
    win32: "win64",
    darwin: "macos",
    linux: "linux",
  };
  const archs = {
    x64: "amd64",
    arm64: "arm64",
  };
  const platform = platforms[process.platform] ?? process.platform;
  const arch = archs[process.arch] ?? process.arch;
  const baseUrl = `https://github.com/bbc/audiowaveform/releases/download/${version}`;
  let audioWaveformUrl = "";

  if (platform === "win64") {
    const filename = `audiowaveform-${version}-${platform}.zip`;
    audioWaveformUrl = `${baseUrl}/${filename}`;
    await downloadFile(audioWaveformUrl, ".");
    await unzip(filename, "packages/app/resources/bin");
  } else if (platform === "macos") {
    console.error("macOS 平台暂不支持 audiowaveform 下载，请手动安装");
    return;
  } else if (platform === "linux") {
    console.warn("下载的是debian12版本");
    const filename = `audiowaveform_${version}-1-12_${arch}`;
    audioWaveformUrl = `${baseUrl}/${filename}.deb`;
    await downloadFile(audioWaveformUrl, "packages/app/resources/bin", {
      filename: "audiowaveform.deb",
    });
    fs.chmodSync("packages/app/resources/bin/audiowaveform.deb", 0o755);
  }
}

/**
 * 下载 DanmakuFactory 工具
 */
async function downloadDanmakuFactory() {
  // https://github.com/renmu123/DanmakuFactory

  let arch = process.arch;
  if (process.platform === "linux" || process.platform === "darwin") {
    if (arch === "x64") {
      arch = "x86_64";
    }
  }

  const platforms = {
    win32: "windows",
    darwin: "macosx",
  };
  const platform = platforms[process.platform] ?? process.platform;
  const filename = `DanmakuFactory-${platform}-${arch}-CLI.zip`;
  let url = `https://github.com/renmu123/DanmakuFactory/releases/download/v2.1.2/${filename}`;

  await downloadFile(url, ".");
  await unzip(filename, "packages/app/resources/bin");

  // 添加执行权限
  if (process.platform === "linux") {
    fs.chmodSync("packages/app/resources/bin/DanmakuFactory", 0o755);
  }
}

/**
 * 下载基础二进制文件
 */
async function downloadBaseBinary() {
  const filename = `${process.platform}-${process.arch}-2.5.0.zip`;
  const downloadUrl = `https://github.com/renmu123/biliLive-tools/releases/download/0.2.1/${filename}`;
  console.log(`下载 ${downloadUrl}`);

  await downloadFile(downloadUrl, ".");
  await unzip(filename, "packages/app/resources");
}

async function downloadBin() {
  await downloadBaseBinary();
  await downloadMesio();
  await downloadBililiveRecorder();
  await downloadAudioWaveform();
  await downloadDanmakuFactory();
  removeUnusedBinFiles();
}

downloadBin();
