/**
 * Tauri 桌面端入口：先安装适配层，再加载原 renderer 入口（一行不改）。
 *
 * 注意：
 * - 不要使用顶层 await —— macOS 的构建目标是 safari13，不支持 TLA
 * - 窗口在 sidecar 启动前就会显示，这里放一个占位，Vue 挂载时会被清掉
 */
import path from "path-unified";
import { installWindowApi } from "./adapters/tauri";

installWindowApi();

// 桌面模式下 renderer 不会走 main.ts 的 isWeb 注入分支，这里补齐 window.path
// @ts-ignore
window.path = path;

showStartupPlaceholder();

import("@renderer/main");

function showStartupPlaceholder() {
  const container = document.getElementById("app");
  if (!container) return;

  const style = document.createElement("style");
  style.textContent = `
    #tauri-startup {
      position: fixed;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      font-size: 14px;
      letter-spacing: 0.2em;
      color: #9a9a9a;
      pointer-events: none;
    }
    [data-theme="dark"] #tauri-startup { color: #5f5f66; }
  `;
  document.head.appendChild(style);

  const placeholder = document.createElement("div");
  placeholder.id = "tauri-startup";
  placeholder.textContent = "正在启动…";
  container.appendChild(placeholder);

  // Vue 挂载时会清空 #app，这里兜底防止残留
  setTimeout(() => document.getElementById("tauri-startup")?.remove(), 60_000);
}
