<template>
  <div class="tool-workbench">
    <header class="page-header">
      <div>
        <h2>章节生成</h2>
        <p>分析直播录像与弹幕，生成 B站章节目录和置顶评论时间轴</p>
      </div>
      <n-button text type="primary" @click="openQueue">查看任务队列</n-button>
    </header>

    <div class="workspace-grid">
      <n-card class="workspace-card file-card" :bordered="false">
        <template #header>
          <div class="card-heading"><span class="step-number">1</span>输入文件</div>
        </template>

        <div class="setting-section">
          <div class="setting-title">视频文件</div>
          <div class="path-control">
            <n-input v-model:value="files.videoFile" placeholder="选择完整的录像文件" />
            <n-button :disabled="generating" @click="selectVideo">选择视频</n-button>
          </div>
        </div>

        <div class="setting-section">
          <div class="setting-title">弹幕文件</div>
          <div class="path-control">
            <n-input
              v-model:value="files.danmuFile"
              placeholder="弹幕 XML 文件，留空则仅根据语音分析"
            />
            <n-button :disabled="generating" @click="selectDanmu">选择弹幕</n-button>
          </div>
          <n-text depth="3" class="file-hint">{{ danmuHint }}</n-text>
        </div>
      </n-card>

      <n-card class="workspace-card settings-card" :bordered="false">
        <template #header>
          <div class="card-heading"><span class="step-number">2</span>设置</div>
        </template>

        <div class="setting-section">
          <div class="setting-title">AI 模型</div>
          <n-select
            v-model:value="options.asrModelId"
            :options="asrModelOptions"
            placeholder="ASR 模型（默认使用字幕识别的模型）"
            clearable
          />
          <n-select
            v-model:value="options.llmModelId"
            :options="llmModelOptions"
            placeholder="LLM 模型（默认使用配置中的章节生成模型）"
            clearable
            style="margin-top: 10px"
          />
          <n-text depth="3" class="file-hint">模型在「设置 - AI配置」中管理</n-text>
        </div>

        <div class="setting-section">
          <div class="setting-title">章节参数</div>
          <n-form label-placement="left" :label-width="120" size="small">
            <n-form-item label="章节数量上限">
              <n-input-number v-model:value="options.maxChapters" :min="2" :max="60" />
            </n-form-item>
            <n-form-item label="最小间隔（秒）">
              <n-input-number v-model:value="options.minChapterInterval" :min="5" :max="3600" />
            </n-form-item>
            <n-form-item label="标题字数上限">
              <n-input-number v-model:value="options.maxTitleLength" :min="2" :max="40" />
            </n-form-item>
            <n-form-item>
              <template #label>
                <Tip
                  text="时间轴条数上限"
                  tip="置顶评论时间轴的主干章节必选，弹幕高能与唱歌条目按重要性补入，最多这么多条"
                ></Tip>
              </template>
              <n-input-number v-model:value="options.timelineMaxItems" :min="0" :max="200" />
            </n-form-item>
            <n-form-item>
              <template #label>
                <Tip text="时间轴字数上限" tip="B站评论有字数限制，默认 900 字"></Tip>
              </template>
              <n-input-number v-model:value="options.timelineMaxChars" :min="0" :max="2000" />
            </n-form-item>
            <n-form-item label="时间轴含高能点">
              <n-switch v-model:value="options.timelineWithHighlight" />
            </n-form-item>
          </n-form>
        </div>

        <div class="setting-section">
          <div class="setting-title">唱歌识别</div>
          <n-form label-placement="left" :label-width="120" size="small">
            <n-form-item>
              <template #label>
                <Tip
                  text="检测唱歌片段"
                  tip="综合音频特征、语音识别结果、弹幕来定位唱歌片段，会明显增加分析耗时"
                ></Tip>
              </template>
              <n-switch v-model:value="options.detectSinging" />
            </n-form-item>
            <n-form-item>
              <template #label>
                <Tip
                  text="推测歌名"
                  tip="在复核片段时让大模型顺便猜歌名，猜不准可能出错，且每次会多一次调用"
                ></Tip>
              </template>
              <n-switch
                v-model:value="options.recognizeMusicName"
                :disabled="!options.detectSinging"
              />
            </n-form-item>
          </n-form>
        </div>
      </n-card>
    </div>

    <n-alert
      v-if="errorMessage"
      class="submission-result"
      type="error"
      :title="errorMessage"
      closable
      @close="errorMessage = ''"
    />

    <div class="submit-bar">
      <div class="submit-summary">
        <strong>{{ submitTitle }}</strong>
        <n-text depth="3" :title="submitHint">{{ submitHint }}</n-text>
      </div>
      <n-button
        type="primary"
        size="large"
        :loading="generating"
        :disabled="!canGenerate"
        @click="generate"
      >
        生成章节
      </n-button>
    </div>

    <n-card
      v-if="generating || progress > 0"
      class="workspace-card progress-card"
      :bordered="false"
    >
      <n-progress
        type="line"
        :percentage="progress"
        :indicator-placement="'inside'"
        :height="18"
        processing
      />
      <n-text depth="3">{{ progressMessage }}</n-text>
    </n-card>

    <n-card v-if="hasResult" class="workspace-card result-card" :bordered="false">
      <template #header>
        <div class="card-heading">生成结果</div>
      </template>
      <template #header-extra>
        <n-text depth="3">
          视频时长 {{ durationText }} · 共 {{ chapters.length }} 个章节<span v-if="danmakuSummary">
            · 弹幕 {{ danmakuSummary.total }} 条</span
          ><span v-if="singing.length"> · 唱歌 {{ singing.length }} 段</span>
        </n-text>
      </template>

      <n-tabs v-model:value="activeTab" type="segment">
        <n-tab-pane name="chapter" tab="B站章节">
          <n-input v-model:value="chapterText" type="textarea" :rows="14" />
          <div class="result-actions">
            <n-button size="small" @click="copyText(chapterText, '章节')">复制章节</n-button>
            <n-text depth="3">粘贴到投稿页的「分段章节」中</n-text>
          </div>
        </n-tab-pane>
        <n-tab-pane name="timeline" tab="置顶评论">
          <n-input v-model:value="timelineText" type="textarea" :rows="14" />
          <div class="result-actions">
            <n-button size="small" @click="copyText(timelineText, '时间轴')">复制时间轴</n-button>
            <n-text depth="3">发布后置顶评论即可，时间戳可直接跳转</n-text>
          </div>
        </n-tab-pane>
        <n-tab-pane v-if="singing.length" name="singing" tab="唱歌片段">
          <div class="singing-list">
            <div v-for="(segment, index) in singing" :key="index" class="singing-item">
              <n-tag size="small" type="warning">
                {{ formatSeconds(segment.start) }} - {{ formatSeconds(segment.end) }}
              </n-tag>
              <n-text>{{ segment.name ? `《${segment.name}》` : "（未识别歌名）" }}</n-text>
              <n-text depth="3">置信度 {{ (segment.confidence * 100).toFixed(0) }}%</n-text>
              <n-text depth="3">{{ sourceLabel(segment.sources) }}</n-text>
            </div>
          </div>
          <div class="result-actions">
            <n-button size="small" @click="copyText(singingText, '唱歌片段')">复制列表</n-button>
            <n-text depth="3">可复制到切片工具中手动划定位置</n-text>
          </div>
        </n-tab-pane>
        <n-tab-pane name="json" tab="结构化数据">
          <n-input v-model:value="jsonText" type="textarea" :rows="14" />
          <div class="result-actions">
            <n-button size="small" @click="copyText(jsonText, 'JSON')">复制 JSON</n-button>
          </div>
        </n-tab-pane>
      </n-tabs>
    </n-card>
  </div>
</template>

<script setup lang="ts">
import { useStorage } from "@vueuse/core";
import { useRouter } from "vue-router";

import { aiApi, commonApi, taskApi } from "@renderer/apis";
import { useNotice } from "@renderer/hooks/useNotice";
import { useAppConfig } from "@renderer/stores";
import { supportedVideoExtensions } from "@renderer/utils";
import { showFileDialog } from "@renderer/utils/fileSystem";

import type { Task } from "@renderer/types";

defineOptions({ name: "Chapter" });

interface ChapterItem {
  start: number;
  end: number;
  title: string;
  highlight: boolean;
  musicName?: string;
}

interface SingingSegment {
  start: number;
  end: number;
  confidence: number;
  name?: string;
  sources: string[];
}

interface ChapterExtra {
  chapters: ChapterItem[];
  singing?: SingingSegment[];
  chapterText: string;
  timelineText: string;
  duration: number;
  danmaku: {
    total: number;
    paidCount: number;
    duration: number;
    spots: { time: number; count: number; keywords: string[] }[];
  } | null;
}

const notice = useNotice();
const router = useRouter();
const { appConfig } = storeToRefs(useAppConfig());

const files = useStorage("chapter-files", {
  videoFile: "",
  danmuFile: "",
});
const options = useStorage("chapter-options", {
  asrModelId: null as string | null,
  llmModelId: null as string | null,
  maxChapters: 20,
  minChapterInterval: 60,
  maxTitleLength: 16,
  timelineWithHighlight: true,
  detectSinging: true,
  recognizeMusicName: false,
  timelineMaxItems: 60,
  timelineMaxChars: 900,
});

const activeTab = ref<"chapter" | "timeline" | "json">("chapter");
const taskId = ref("");
const task = ref<Task | null>(null);
const errorMessage = ref("");
const progress = ref(0);
const progressMessage = ref("");
const chapters = ref<ChapterItem[]>([]);
const singing = ref<SingingSegment[]>([]);
const chapterText = ref("");
const timelineText = ref("");
const jsonText = ref("");
const danmakuSummary = ref<ChapterExtra["danmaku"]>(null);
const duration = ref(0);

const generating = computed(
  () => !!task.value && ["pending", "running", "paused"].includes(task.value.status),
);
const hasResult = computed(() => chapters.value.length > 0);
const canGenerate = computed(() => !!files.value.videoFile && !generating.value);

const asrModelOptions = computed(() =>
  appConfig.value.ai.models
    .filter((model) => model.tags.includes("asr"))
    .map((model) => ({
      label: `${model.modelName}${model.remark ? `（${model.remark}）` : ""}`,
      value: model.modelId,
    })),
);
const llmModelOptions = computed(() =>
  appConfig.value.ai.models
    .filter((model) => model.tags.includes("llm"))
    .map((model) => ({
      label: `${model.modelName}${model.remark ? `（${model.remark}）` : ""}`,
      value: model.modelId,
    })),
);

const danmuHint = computed(() =>
  files.value.danmuFile
    ? "弹幕用于判断高能时刻和话题热度，能显著提升标题质量"
    : "未选择弹幕文件时仅根据语音内容生成",
);
const submitTitle = computed(() =>
  generating.value ? "正在生成章节" : hasResult.value ? "可重新生成以调整结果" : "分析并生成章节",
);
const submitHint = computed(() => {
  if (generating.value) return progressMessage.value || "正在处理";
  if (!files.value.videoFile) return "请先选择视频文件";
  return "长视频的语音识别耗时较长，可提交后去任务队列查看进度";
});
const durationText = computed(() => {
  const total = Math.round(duration.value);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
});
const singingText = computed(() =>
  singing.value
    .map((segment) => {
      const name = segment.name ? `《${segment.name}》` : "";
      return `${formatSeconds(segment.start)} - ${formatSeconds(segment.end)} ${name}`.trim();
    })
    .join("\n"),
);

const formatSeconds = (seconds: number) => {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
};

const SOURCE_LABELS: Record<string, string> = {
  audio: "音频特征",
  asr: "语音识别",
  danmaku: "弹幕",
  llm: "模型复核",
};
const sourceLabel = (sources: string[]) =>
  sources.map((source) => SOURCE_LABELS[source] ?? source).join(" + ");

let timer: ReturnType<typeof setInterval> | null = null;

const startPolling = () => {
  stopPolling();
  timer = setInterval(async () => {
    if (!taskId.value) return stopPolling();
    try {
      const data = await taskApi.get(taskId.value);
      task.value = data;
      progress.value = data.progress ?? 0;
      progressMessage.value = data.custsomProgressMsg ?? "";
      if (data.status === "completed") {
        const extra = data.extra as unknown as ChapterExtra | undefined;
        if (extra?.chapters) {
          chapters.value = extra.chapters;
          singing.value = extra.singing ?? [];
          chapterText.value = extra.chapterText;
          timelineText.value = extra.timelineText;
          jsonText.value = JSON.stringify(
            { chapters: extra.chapters, singing: extra.singing ?? [] },
            null,
            2,
          );
          danmakuSummary.value = extra.danmaku ?? null;
          duration.value = extra.duration ?? 0;
          activeTab.value = "chapter";
          notice.success({
            title: `章节生成完成，共 ${extra.chapters.length} 个章节${
              extra.singing?.length ? `、${extra.singing.length} 个唱歌片段` : ""
            }`,
          });
        }
        stopPolling();
      } else if (data.status === "error") {
        errorMessage.value = data.error || "章节生成失败";
        stopPolling();
      } else if (data.status === "canceled") {
        stopPolling();
      }
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : String(error);
      stopPolling();
    }
  }, 1000);
};

const stopPolling = () => {
  if (timer) clearInterval(timer);
  timer = null;
};

onActivated(() => {
  if (generating.value) startPolling();
});
onDeactivated(stopPolling);
onBeforeUnmount(stopPolling);

const selectVideo = async () => {
  const selected = await showFileDialog({ extensions: supportedVideoExtensions });
  const file = selected?.[0];
  if (!file) return;
  files.value.videoFile = file;
  await autoMatchDanmu(file);
};

const selectDanmu = async () => {
  const selected = await showFileDialog({ extensions: ["xml"] });
  const file = selected?.[0];
  if (!file) return;
  files.value.danmuFile = file;
};

/** 选择视频后尝试匹配同目录同名的弹幕文件 */
const autoMatchDanmu = async (videoFile: string) => {
  const dotIndex = videoFile.lastIndexOf(".");
  if (dotIndex === -1) return;
  const base = videoFile.slice(0, dotIndex);
  const candidates = [videoFile.slice(0, dotIndex) + ".xml"];
  const danmuBase = base.replace(/[-_\s]*(弹幕版?|danmu|弹幕)$/i, "");
  if (danmuBase !== base) candidates.push(`${danmuBase}.xml`);

  for (const candidate of candidates) {
    if (await commonApi.fileExists(candidate)) {
      files.value.danmuFile = candidate;
      notice.info({ title: "已自动匹配到同名弹幕文件" });
      return;
    }
  }
};

const generate = async () => {
  if (!files.value.videoFile) {
    notice.error({ title: "请先选择视频文件" });
    return;
  }
  errorMessage.value = "";
  progress.value = 0;
  progressMessage.value = "正在提交任务";
  task.value = null;

  try {
    const result = await aiApi.chapterGenerate({
      videoFile: files.value.videoFile,
      danmuFile: files.value.danmuFile || undefined,
      maxChapters: options.value.maxChapters,
      minChapterInterval: options.value.minChapterInterval,
      maxTitleLength: options.value.maxTitleLength,
      timelineWithHighlight: options.value.timelineWithHighlight,
      detectSinging: options.value.detectSinging,
      recognizeMusicName: options.value.recognizeMusicName,
      timelineMaxItems: options.value.timelineMaxItems,
      timelineMaxChars: options.value.timelineMaxChars,
      asrModelId: options.value.asrModelId || undefined,
      llmModelId: options.value.llmModelId || undefined,
    });
    taskId.value = result.taskId;
    task.value = { taskId: result.taskId, status: "pending", progress: 0 } as Task;
    startPolling();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  }
};

const copyText = async (text: string, name: string) => {
  if (!text) return;
  await navigator.clipboard.writeText(text);
  notice.success({ title: `${name}已复制` });
};

const openQueue = () => router.push({ name: "Queue" });
</script>

<style scoped lang="less">
@import "../workbench.less";

.progress-card,
.result-card {
  margin-top: 18px;
  padding: 4px;
}

.progress-card .n-text {
  display: block;
  margin-top: 8px;
  font-size: 12px;
}

.result-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;

  .n-text {
    font-size: 12px;
  }
}

.singing-list {
  max-height: 320px;
  overflow-y: auto;
}

.singing-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 0;
  border-bottom: 1px solid var(--border-secondary);
  font-size: 13px;
}

.path-control + .path-control,
.setting-section .n-select + .n-select {
  margin-top: 10px;
}

@media (max-width: 600px) {
  .result-actions {
    flex-wrap: wrap;
  }
}
</style>
