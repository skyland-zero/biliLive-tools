/**
 * 仓库内下载外部资源（外部工具、原生 prebuild 等）的统一封装。
 *
 * `download` 底层的 got 不读 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量，在有代理的机器上会
 * 直接 `connect ETIMEDOUT`，而这类资源的源站都在 GitHub。这里在检测到代理环境变量时
 * 注入 `https-proxy-agent`，其余情况行为和直接用 `download` 完全一致。
 *
 * 保持同步返回（`download` 返回的是带 `.on()` 的 Promise，调用方要挂进度事件）。
 */

import download from "download";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let cachedAgent;
let cached = false;

function resolveProxyAgent() {
  if (cached) {
    return cachedAgent;
  }
  cached = true;
  const proxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  if (!proxy) {
    return null;
  }
  const { HttpsProxyAgent } = require("https-proxy-agent");
  cachedAgent = new HttpsProxyAgent(proxy);
  return cachedAgent;
}

/**
 * @param {string} url
 * @param {string} destination 目标目录（文件名沿用响应头/URL 里的文件名）
 * @param {import("download").Options} [options]
 */
export function downloadWithProxy(url, destination, options = {}) {
  const agent = resolveProxyAgent();
  if (!agent) {
    return download(url, destination, options);
  }
  // got 的 agent 选项按协议区分
  return download(url, destination, { ...options, agent: { http: agent, https: agent } });
}
