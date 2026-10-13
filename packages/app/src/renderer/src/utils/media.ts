import { commonApi } from "@renderer/apis";

export type VideoSourceType = "" | "flv" | "ts" | "m3u8";

/**
 * 当前环境是否必须通过 http 地址播放本地视频
 *
 * - Electron：渲染层由 `file://` 提供，`<video src="D:\xx.mp4">` 会被解析成本地文件，可直接播放
 * - 浏览器 / Tauri：页面是 http(s) 源，本地路径会被当成相对地址请求（如
 *   `http://localhost:28081/D:\xx.mp4`），视频无法播放，
 *   需要由 sidecar 通过 `/common/video/:videoId` 提供带 Range 的视频流
 */
export function needServerVideoSource(): boolean {
  return Boolean(window.isWeb || window.isTauri);
}

/**
 * 将本地视频路径转换为当前运行环境可播放的地址
 * @param path 本地视频文件路径
 */
export async function resolveVideoSource(
  path: string,
): Promise<{ url: string; type: VideoSourceType }> {
  if (needServerVideoSource()) {
    const { videoId, type } = await commonApi.applyVideoId(path);
    return { url: commonApi.getVideo(videoId), type: (type ?? "") as VideoSourceType };
  }

  return { url: path, type: path.endsWith(".flv") ? "flv" : "" };
}
