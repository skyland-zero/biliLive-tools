import { ref } from "vue";
import { resolveVideoSource } from "@renderer/utils/media";
import type Artplayer from "artplayer";

export function useVideoPlayer() {
  const videoInstance = ref<Artplayer | null>(null);
  const videoRef = ref<any>(null);

  /**
   * 加载视频文件
   * @param path 视频文件路径
   */
  const loadVideo = async (path: string) => {
    const { url, type } = await resolveVideoSource(path);
    await videoRef.value?.switchUrl(url, type as any);
    return url;
  };

  /**
   * 视频状态切换
   */
  const togglePlay = () => {
    if (!videoInstance.value?.url) return;
    videoInstance.value.toggle();
  };

  /**
   * 视频播放器就绪回调
   */
  const handleVideoReady = (instance: Artplayer) => {
    videoInstance.value = instance;
  };

  return {
    videoInstance,
    videoRef,
    loadVideo,
    togglePlay,
    handleVideoReady,
  };
}
