<template>
  <div class="tool-workbench">
    <header class="page-header">
      <div>
        <h2>视频转码</h2>
        <p>批量转换视频格式，或将弹幕烧录到视频中</p>
      </div>
      <n-button text type="primary" @click="openQueue">查看任务队列</n-button>
    </header>

    <div class="workspace-grid">
      <n-card class="workspace-card file-card" :bordered="false">
        <template #header>
          <div class="card-heading"><span class="step-number">1</span>输入文件</div>
        </template>
        <template #header-extra>
          <div class="file-actions">
            <n-text depth="3">已选择 {{ fileList.length }} 个</n-text>
            <n-dropdown
              v-if="options.mergeIntoOne"
              :options="sortOptions"
              :disabled="fileList.length < 2 || submitting"
              @select="sortFiles"
            >
              <n-button size="small" :disabled="fileList.length < 2 || submitting">排序</n-button>
            </n-dropdown>
            <n-button size="small" :disabled="submitting" @click="addVideo">添加文件</n-button>
            <n-button size="small" :disabled="fileList.length === 0 || submitting" @click="clear">
              清空
            </n-button>
          </div>
        </template>

        <FileSelect
          ref="fileSelect"
          v-model="fileList"
          :sort="options.mergeIntoOne"
          :extensions="[...supportedVideoExtensions, 'xml', 'ass']"
          input-placeholder="输入内容将会被用为文件名"
          area-placeholder="请选择视频文件，可同时选择对应的弹幕文件"
        />
        <n-text depth="3" class="file-hint">
          {{
            options.mergeIntoOne
              ? isWeb
                ? "可一次选择同一场直播的多个分片及对应弹幕文件，合并后压制成一个视频"
                : "可点击选择或拖入同一场直播的多个分片及对应弹幕文件，合并后压制成一个视频"
              : isWeb
                ? "可一次选择多个视频及弹幕文件"
                : "可点击选择或拖入多个视频及弹幕文件"
          }}
        </n-text>
      </n-card>

      <n-card class="workspace-card settings-card" :bordered="false">
        <template #header>
          <div class="card-heading"><span class="step-number">2</span>设置</div>
        </template>

        <div class="setting-section source-option">
          <n-checkbox v-model:checked="options.mergeIntoOne">合并为一个视频</n-checkbox>
          <n-text depth="3">
            {{
              options.mergeIntoOne
                ? "按当前顺序合并所有视频，并把各分片弹幕合并后一起压制，输出文件名为第一个视频的文件名（所有视频都需要选择弹幕文件）"
                : "每个视频单独压制"
            }}
          </n-text>
        </div>

        <div class="setting-section">
          <div class="setting-title">视频预设</div>
          <n-cascader
            v-model:value="options.ffmpegPresetId"
            placeholder="请选择视频预设"
            expand-trigger="click"
            :options="ffmpegOptions"
            check-strategy="child"
            :show-path="false"
            :filterable="true"
          />
        </div>

        <div class="setting-section">
          <div class="setting-title">弹幕预设</div>
          <n-select
            v-model:value="options.danmuPresetId"
            :options="danmuPresetsOptions"
            placeholder="选择弹幕预设"
          />
        </div>

        <div class="setting-section source-option">
          <n-checkbox v-model:checked="options.hotProgress">高能进度条</n-checkbox>
          <n-text depth="3">使用首页的数据；每个视频都需要对应的弹幕文件</n-text>
        </div>

        <div class="setting-section">
          <div class="setting-title">保存位置</div>
          <n-radio-group v-model:value="options.saveRadio" class="save-location">
            <n-radio :value="1">保存到源文件所在文件夹</n-radio>
            <n-radio :value="2">保存到指定文件夹</n-radio>
          </n-radio-group>
          <div v-if="options.saveRadio === 2" class="path-control">
            <n-input
              v-model:value="options.savePath"
              placeholder="选择或输入保存目录"
              title="支持相对路径"
            />
            <n-button @click="getDir">
              <template #icon>
                <n-icon><FolderOpenOutline /></n-icon>
              </template>
              浏览
            </n-button>
          </div>
        </div>

        <div class="setting-section">
          <div class="setting-title">同名文件</div>
          <n-radio-group v-model:value="options.override">
            <n-space>
              <n-radio :value="false">不覆盖已有文件</n-radio>
              <n-radio :value="true">覆盖已有文件</n-radio>
            </n-space>
          </n-radio-group>
        </div>

        <div class="setting-section source-option">
          <n-checkbox v-model:checked="options.removeOrigin">转换完成后移除源文件</n-checkbox>
          <n-text depth="3">仅在转换任务完成后处理源文件</n-text>
        </div>
      </n-card>
    </div>

    <n-alert
      v-if="submissionResult"
      class="submission-result"
      :type="
        submissionResult.failed.length
          ? submissionResult.submitted
            ? 'warning'
            : 'error'
          : 'success'
      "
      :title="`已提交 ${submissionResult.submitted} 个任务${submissionResult.failed.length ? `，${submissionResult.failed.length} 个文件未提交` : ''}`"
      closable
      @close="submissionResult = null"
    >
      <div v-if="submissionResult.failed.length" class="failed-files">
        <div v-for="failure in submissionResult.failed" :key="failure.id">
          {{ failure.name }}：{{ failure.message }}
        </div>
      </div>
      <n-button v-if="submissionResult.submitted" text type="primary" @click="openQueue">
        查看任务队列
      </n-button>
    </n-alert>

    <div class="submit-bar">
      <div class="submit-summary">
        <strong>{{ summaryText }}</strong>
        <n-text depth="3" :title="submitHint">{{ submitHint }}</n-text>
      </div>
      <n-button
        type="primary"
        size="large"
        :loading="submitting"
        :disabled="!canConvert"
        title="快捷键 Ctrl+Enter"
        @click="convert"
      >
        {{ submitText }}
      </n-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { toReactive } from "@vueuse/core";
import hotkeys from "hotkeys-js";
import { cloneDeep } from "lodash-es";
import { FolderOpenOutline } from "@vicons/ionicons5";
import { useRouter } from "vue-router";

import { useConfirm } from "@renderer/hooks";
import { ffmpegPresetApi, taskApi, danmuPresetApi } from "@renderer/apis";
import { useAppConfig, useFfmpegPreset, useDanmuPreset } from "@renderer/stores";
import FileSelect from "./components/FileSelect.vue";
import { showDirectoryDialog } from "@renderer/utils/fileSystem";
import { supportedVideoExtensions } from "@renderer/utils";

defineOptions({ name: "Convert2Mp4" });

const notice = useNotice();
const confirm = useConfirm();
const router = useRouter();
const isWeb = window.isWeb;
const { appConfig } = storeToRefs(useAppConfig());
const { ffmpegOptions } = storeToRefs(useFfmpegPreset());
const { danmuPresetsOptions } = storeToRefs(useDanmuPreset());

const fileList = ref<{ id: string; title: string; videoPath: string; danmakuPath?: string }[]>([]);
const fileSelect = ref<InstanceType<typeof FileSelect> | null>(null);
const submitting = ref(false);
const processedCount = ref(0);
const submittingTotal = ref(0);
const submissionResult = ref<{
  submitted: number;
  failed: { id: string; name: string; message: string }[];
} | null>(null);

watch(submissionResult, (result, _, onCleanup) => {
  if (!result?.submitted || result.failed.length) return;
  const timer = setTimeout(() => {
    submissionResult.value = null;
  }, 10000);
  onCleanup(() => clearTimeout(timer));
});

const options = toReactive(
  computed({
    get: () => appConfig.value.tool.video2mp4,
    set: (value) => {
      appConfig.value.tool.video2mp4 = value;
    },
  }),
);

const canConvert = computed(
  () =>
    !submitting.value &&
    fileList.value.length > 0 &&
    !!options.ffmpegPresetId &&
    !!options.danmuPresetId &&
    (options.saveRadio !== 2 || options.savePath.trim().length > 0),
);
const submitHint = computed(() => {
  if (submitting.value) return `正在提交 ${processedCount.value}/${submittingTotal.value} 个文件`;
  if (!fileList.value.length) return "请先添加视频文件";
  if (!options.ffmpegPresetId) return "请先选择视频预设";
  if (!options.danmuPresetId) return "请先选择弹幕预设";
  if (options.mergeIntoOne) {
    return options.saveRadio === 1
      ? "合并为一个视频，输出到首个视频所在文件夹"
      : `合并为一个视频，输出到 ${options.savePath.trim() || "请先选择保存目录"}`;
  }
  return options.saveRadio === 1
    ? "输出到各源文件夹"
    : options.savePath.trim() || "请先选择保存目录";
});

const summaryText = computed(() =>
  options.mergeIntoOne
    ? `${fileList.value.length} 个分片合并为 1 个视频`
    : `${fileList.value.length} 个文件待转换`,
);
const submitText = computed(() =>
  options.mergeIntoOne
    ? `开始合并压制（${fileList.value.length} 个分片）`
    : `开始转换（${fileList.value.length} 个文件）`,
);

const sortOptions = [
  { key: "asc", label: "文件名升序" },
  { key: "desc", label: "文件名降序" },
];
const sortFiles = (key: string | number) => {
  const direction = key === "asc" ? 1 : -1;
  fileList.value.sort(
    (a, b) => direction * a.videoPath.localeCompare(b.videoPath, "zh-Hans-CN", { numeric: true }),
  );
};

watch(
  () => options.mergeIntoOne,
  (mergeIntoOne) => {
    // 同一场直播的分片按录制时间命名，开启合并后默认按文件名升序排列
    if (mergeIntoOne) sortFiles("asc");
  },
);

onActivated(() => {
  hotkeys("ctrl+enter", () => {
    convert();
  });
});
onDeactivated(() => hotkeys.unbind("ctrl+enter"));
onUnmounted(() => hotkeys.unbind("ctrl+enter"));

const convert = async () => {
  if (submitting.value) return;
  if (!fileList.value.length) {
    notice.error({ title: "至少选择一个文件" });
    return;
  }
  if (options.saveRadio === 2 && !options.savePath.trim()) {
    notice.error({ title: "请选择保存目录" });
    return;
  }
  if (!options.ffmpegPresetId || !options.danmuPresetId) {
    notice.error({ title: "请选择视频和弹幕预设" });
    return;
  }

  submitting.value = true;
  processedCount.value = 0;
  submissionResult.value = null;
  const files = cloneDeep(fileList.value);
  const taskOptions = { ...options };
  const homeOptions = { ...appConfig.value.tool.home };
  submittingTotal.value = taskOptions.mergeIntoOne ? 1 : files.length;

  try {
    const ffmpegConfig = await ffmpegPresetApi.get(taskOptions.ffmpegPresetId);
    if (!ffmpegConfig) {
      notice.error({ title: "视频预设不存在，请重新选择" });
      return;
    }
    const rawDanmuConfig = await danmuPresetApi.get(taskOptions.danmuPresetId);
    if (!rawDanmuConfig) {
      notice.error({ title: "弹幕预设不存在，请重新选择" });
      return;
    }

    const ffmpegConfigOptions = ffmpegConfig.config;
    const danmuOptions = rawDanmuConfig.config;
    const mergeIntoOne = taskOptions.mergeIntoOne;
    const danmuFiles = files.filter((item) => item.danmakuPath);

    if (mergeIntoOne && ffmpegConfigOptions.encoder === "copy") {
      notice.error({
        title: "合并为一个视频时不能使用 copy 编码，请在视频预设中选择其他编码器",
        duration: 3000,
      });
      return;
    }
    if (!mergeIntoOne && ffmpegConfigOptions.encoder === "copy" && danmuFiles.length) {
      notice.error({ title: "存在弹幕文件，视频预设编码器不允许使用 copy 选项" });
      return;
    }
    if (mergeIntoOne && danmuFiles.length !== 0 && danmuFiles.length !== files.length) {
      notice.error({ title: "合并为一个视频时需要为所有视频选择对应的弹幕文件" });
      return;
    }
    if (taskOptions.hotProgress && danmuFiles.length === 0) {
      notice.error({ title: "未选择弹幕文件，无法使用高能进度条" });
      return;
    }
    if (taskOptions.saveRadio === 1) {
      // 合并为一个视频时，使用第一个文件的文件名作为输出文件名
      const conflict = files.find((item, index) => {
        if (mergeIntoOne && index !== 0) return false;
        const title = mergeIntoOne ? files[0].title : item.title;
        return window.path.basename(item.videoPath) === `${title}.mp4`;
      });
      if (conflict) {
        notice.error({
          title: `输入文件与输出文件名相同：${window.path.basename(conflict.videoPath)}，请修改保存路径或文件名`,
          duration: 3000,
        });
        return;
      }
    }

    // 合并视频前检查各分片是否可以直接合并
    if (mergeIntoOne && files.length > 1) {
      const result = await taskApi.checkMergeVideos(files.map((item) => item.videoPath));
      if (result.errors.length || result.warnings.length) {
        const [status] = await confirm.warning({
          title: "继续合并很有可能出现问题，是否继续？",
          content: [...result.errors, ...result.warnings].join("\n"),
        });
        if (!status) return;
      }
    }

    if (ffmpegConfigOptions.encoder !== "copy") {
      const [status] = await confirm.warning({
        content:
          "你可能正在对视频进行重编码，将耗费大量时间，是否继续？（如果你只是想转封装，可以选择预设中的 copy 选项）",
        showCheckbox: true,
        showAgainKey: "video2mp4Convert",
      });
      if (!status) return;
    }

    const submittedIds = new Set<string>();
    const failed: { id: string; name: string; message: string }[] = [];
    const hotProgressOptions = {
      interval: homeOptions.hotProgressSample,
      height: homeOptions.hotProgressHeight,
      color: homeOptions.hotProgressColor,
      fillColor: homeOptions.hotProgressFillColor,
    };
    let submittedCount = 0;

    if (mergeIntoOne) {
      // 合并压制：所有分片合并为一个视频，只提交一个任务，输出文件名取第一个文件的文件名
      const outputName = `${files[0].title}.mp4`;
      try {
        await taskApi.mergeVideoAndBurn(
          files.map((file) => ({
            videoPath: file.videoPath,
            danmuPath: file.danmakuPath || undefined,
          })),
          outputName,
          {
            danmaOptions: danmuOptions,
            ffmpegOptions: ffmpegConfigOptions,
            hotProgressOptions,
            hasHotProgress: taskOptions.hotProgress,
            override: taskOptions.override,
            removeOrigin: taskOptions.removeOrigin,
            savePath: taskOptions.savePath,
            saveType: taskOptions.saveRadio,
          },
        );
        files.forEach((file) => submittedIds.add(file.id));
        submittedCount = 1;
      } catch (error) {
        failed.push({
          id: files[0].id,
          name: files[0].title,
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        processedCount.value = submittingTotal.value;
      }
    } else {
      for (const file of files) {
        const outputName = `${file.title}.mp4`;
        try {
          if (file.danmakuPath) {
            await taskApi.burn(
              { videoFilePath: file.videoPath, subtitleFilePath: file.danmakuPath },
              outputName,
              {
                danmaOptions: danmuOptions,
                ffmpegOptions: ffmpegConfigOptions,
                hotProgressOptions,
                hasHotProgress: taskOptions.hotProgress,
                override: taskOptions.override,
                removeOrigin: taskOptions.removeOrigin,
                savePath: taskOptions.savePath,
                saveType: taskOptions.saveRadio,
              },
            );
          } else {
            await taskApi.transcode(file.videoPath, outputName, ffmpegConfigOptions, {
              override: taskOptions.override,
              removeOrigin: taskOptions.removeOrigin,
              savePath: taskOptions.savePath,
              saveType: taskOptions.saveRadio,
            });
          }
          submittedIds.add(file.id);
        } catch (error) {
          failed.push({
            id: file.id,
            name: file.title,
            message: error instanceof Error ? error.message : String(error),
          });
        } finally {
          processedCount.value += 1;
        }
      }
      submittedCount = submittedIds.size;
    }

    fileList.value = fileList.value.filter((file) => !submittedIds.has(file.id));
    submissionResult.value = { submitted: submittedCount, failed };
  } catch (error) {
    notice.error({ title: error instanceof Error ? error.message : String(error) });
  } finally {
    submitting.value = false;
  }
};

async function getDir() {
  const dir = await showDirectoryDialog({ defaultPath: options.savePath });
  if (!dir) return;
  options.savePath = dir;
  options.saveRadio = 2;
}

const addVideo = () => fileSelect.value?.select();
const clear = () => {
  fileList.value = [];
};
const openQueue = () => router.push({ name: "Queue" });
</script>

<style scoped lang="less">
@import "../workbench.less";

.setting-section .n-cascader,
.setting-section .n-select {
  width: 100%;
}
</style>
