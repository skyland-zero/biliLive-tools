<template>
  <div class="about-container">
    <!-- 头部信息卡片 -->
    <n-card class="about-hero-card" :bordered="false">
      <div class="hero-content">
        <div class="hero-title-row">
          <h1 class="app-title">biliLive-tools</h1>
          <div class="tags-row">
            <n-tag type="primary" size="small" round>
              {{ isWeb ? "接口版本" : "版本" }} v{{ version || "--" }}
            </n-tag>
            <n-tag v-if="isWeb && webVersion" type="info" size="small" round>
              网页版本 v{{ webVersion }}
            </n-tag>
            <n-tag size="small" round>GPLv3 授权</n-tag>
          </div>
        </div>
        <p class="app-desc">
          B站直播录制与视频弹幕处理一站式工具。致力于解决录播工具链碎片化问题，将录制、修复、切片、转码、弹幕渲染、合并与上传无缝连接。
        </p>

        <!-- 快速链接按钮组 -->
        <div class="action-links">
          <n-button
            type="primary"
            tag="a"
            href="https://docs.irenmu.com/"
            target="_blank"
            rel="noreferrer"
            secondary
          >
            <template #icon>
              <n-icon><BookOutline /></n-icon>
            </template>
            官方文档
          </n-button>
          <n-button
            type="info"
            tag="a"
            href="https://www.bilibili.com/video/BV1Hs421M755/"
            target="_blank"
            rel="noreferrer"
            secondary
          >
            <template #icon>
              <n-icon><VideocamOutline /></n-icon>
            </template>
            视频教程
          </n-button>
          <n-button
            tag="a"
            href="https://github.com/renmu123/biliLive-tools"
            target="_blank"
            rel="noreferrer"
            secondary
          >
            <template #icon>
              <n-icon><LogoGithub /></n-icon>
            </template>
            GitHub 项目
          </n-button>
          <n-button
            tag="a"
            href="https://github.com/renmu123/biliLive-tools/blob/master/CHANGELOG.md"
            target="_blank"
            rel="noreferrer"
            quaternary
          >
            更新历史
          </n-button>
          <n-button
            tag="a"
            href="https://pan.quark.cn/s/6da253a1ecb8"
            target="_blank"
            rel="noreferrer"
            quaternary
          >
            夸克网盘备用
          </n-button>
        </div>
      </div>
    </n-card>

    <!-- 详细信息网格 -->
    <div class="about-grid">
      <!-- 社区与反馈 -->
      <n-card title="社区与反馈" size="small" :bordered="false" class="info-card">
        <n-descriptions :column="1" label-placement="left">
          <n-descriptions-item label="作者">
            <a
              href="https://space.bilibili.com/10995238"
              class="link"
              target="_blank"
              rel="noreferrer"
              >renmu123</a
            >
            （点点关注，秋梨膏）
          </n-descriptions-item>
          <n-descriptions-item label="QQ交流群">
            <n-tag size="small" :bordered="false" type="info">872011161</n-tag>
          </n-descriptions-item>
          <n-descriptions-item label="问题反馈">
            如遇到 Bug，请在设置中将“Log等级”调至 debug 并复现，在
            <a
              href="https://github.com/renmu123/biliLive-tools/issues"
              class="link"
              target="_blank"
              rel="noreferrer"
              >Issues</a
            >
            提交步骤与日志文件。
          </n-descriptions-item>
        </n-descriptions>
      </n-card>

      <!-- 赞助支持 -->
      <n-card title="赞助与支持" size="small" :bordered="false" class="info-card">
        <p class="sponsor-desc">
          如果觉得 biliLive-tools 对你有帮助，欢迎请作者喝瓶快乐水或通过 B 站充电支持后续开发维护！
        </p>
        <n-space style="margin-top: 12px">
          <n-button
            type="warning"
            size="small"
            secondary
            tag="a"
            href="https://afdian.com/a/renmu123"
            target="_blank"
            rel="noreferrer"
          >
            <template #icon>
              <n-icon><HeartOutline /></n-icon>
            </template>
            爱发电赞助
          </n-button>
          <n-button
            type="primary"
            size="small"
            secondary
            tag="a"
            href="https://space.bilibili.com/10995238"
            target="_blank"
            rel="noreferrer"
          >
            B站空间充电
          </n-button>
        </n-space>
      </n-card>
    </div>

    <!-- 开源致谢 -->
    <n-card title="致谢与依赖" size="small" :bordered="false" class="info-card">
      <p style="margin: 0 0 12px; color: var(--text-muted)">
        感谢以下开源项目与社区贡献者为本工具提供的强大技术基石：
      </p>
      <div class="thanks-list">
        <a
          v-for="item in thanksProjects"
          :key="item.name"
          :href="item.url"
          class="thanks-item"
          target="_blank"
          rel="noreferrer"
        >
          <span class="thanks-name">{{ item.name }}</span>
          <span class="thanks-desc">{{ item.desc }}</span>
        </a>
      </div>
    </n-card>
  </div>
</template>

<script setup lang="ts">
import { commonApi } from "@renderer/apis";
import { BookOutline, LogoGithub, VideocamOutline, HeartOutline } from "@vicons/ionicons5";

defineOptions({
  name: "About",
});

const isWeb = computed(() => window.isWeb);
const webVersion = import.meta.env.VITE_VERSION;
const version = ref("");

onMounted(async () => {
  version.value = await commonApi.version();
});

const thanksProjects = [
  {
    name: "DanmakuFactory",
    desc: "高效弹幕转换工具",
    url: "https://github.com/hihkm/DanmakuFactory",
  },
  {
    name: "biliup-rs",
    desc: "全能 B 站投稿与录播流水线",
    url: "https://github.com/biliup/biliup-rs",
  },
  {
    name: "BililiveRecorder",
    desc: "便携稳定的 B 站录播姬",
    url: "https://github.com/BililiveRecorder/BililiveRecorder",
  },
  {
    name: "biliAPI",
    desc: "B站核心 API 解析封装",
    url: "https://github.com/renmu123/biliAPI",
  },
  {
    name: "LiveAutoRecord",
    desc: "多平台直播自动化录制框架",
    url: "https://github.com/WhiteMinds/LiveAutoRecord",
  },
];
</script>

<style scoped lang="less">
.about-container {
  max-width: 960px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding-bottom: 24px;
}

.about-hero-card {
  border-radius: 12px;
  background: var(--bg-card);
  border: 1px solid var(--border-secondary);

  .hero-title-row {
    display: flex;
    align-items: center;
    gap: 14px;
    flex-wrap: wrap;
    margin-bottom: 12px;

    .app-title {
      margin: 0;
      font-size: 26px;
      font-weight: 700;
      color: var(--text-primary);
    }

    .tags-row {
      display: flex;
      gap: 8px;
      align-items: center;
    }
  }

  .app-desc {
    margin: 0 0 16px;
    color: var(--text-secondary);
    line-height: 1.6;
    font-size: 14px;
  }

  .action-links {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    align-items: center;
  }
}

.about-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 16px;
}

.info-card {
  border-radius: 10px;
  background: var(--bg-card);
  border: 1px solid var(--border-secondary);

  .sponsor-desc {
    margin: 0;
    color: var(--text-secondary);
    line-height: 1.6;
    font-size: 13px;
  }
}

.thanks-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 10px;

  .thanks-item {
    display: flex;
    flex-direction: column;
    padding: 10px 14px;
    border-radius: 8px;
    border: 1px solid var(--border-secondary);
    background: var(--bg-primary);
    text-decoration: none;
    transition: all 0.2s ease;

    &:hover {
      border-color: var(--color-primary);
      transform: translateY(-2px);
      box-shadow: 0 4px 10px var(--shadow-color);
    }

    .thanks-name {
      font-weight: 600;
      font-size: 14px;
      color: var(--text-primary);
      margin-bottom: 4px;
    }

    .thanks-desc {
      font-size: 12px;
      color: var(--text-muted);
    }
  }
}

.link {
  color: var(--color-primary);
  text-decoration: none;

  &:hover {
    text-decoration: underline;
  }
}
</style>
