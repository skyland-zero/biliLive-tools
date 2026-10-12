import path from "node:path";
import fs from "fs-extra";

import { addExtractAudioTask } from "../task/video.js";
import { recognize } from "../ai/asr/adapter.js";
import { QwenLLM } from "../ai/llm/qwen.js";
import { appConfig } from "../config.js";
import { getModel } from "../musicDetector/utils.js";
import logger from "../utils/log.js";
import { getTempPath, calculateFileQuickHash } from "../utils/index.js";
import { analyzeDanmaku, formatDanmakuForPrompt, formatTimestamp } from "./danmaku.js";
import {
  buildMergeRequirement,
  buildTranscriptLines,
  chunkTranscriptLines,
  formatTranscriptLines,
  parseLlmJson,
  parseTimeToSeconds,
  CHUNK_SYSTEM_PROMPT,
} from "./prompt.js";

import type { StandardASRResult } from "../ai/asr/types.js";
import type { DanmakuAnalysis } from "./danmaku.js";
import type { TranscriptLine } from "./prompt.js";

export * from "./danmaku.js";
export * from "./prompt.js";

export interface ChapterProgress {
  stage: string;
  percentage: number;
  message: string;
}

export interface ChapterItem {
  /** 章节开始时间（秒） */
  start: number;
  /** 章节结束时间（秒） */
  end: number;
  /** 章节标题 */
  title: string;
  /** 是否为弹幕高能章节 */
  highlight: boolean;
}

export interface GenerateChaptersOptions {
  /** 视频文件路径 */
  videoFile: string;
  /** 弹幕 XML 文件路径 */
  danmuFile?: string;
  /** 章节数量上限 */
  maxChapters?: number;
  /** 相邻章节最小间隔（秒） */
  minChapterInterval?: number;
  /** 标题最大字数 */
  maxTitleLength?: number;
  /** 置顶评论时间轴是否包含弹幕高能点 */
  timelineWithHighlight?: boolean;
  /** 覆盖配置中的 ASR 模型 */
  asrModelId?: string;
  /** 覆盖配置中的 LLM 模型 */
  llmModelId?: string;
  /** 覆盖配置中的提示词 */
  prompt?: string;
  /** 进度回调 */
  onProgress?: (data: ChapterProgress) => void;
  /** 是否已取消 */
  isCanceled?: () => boolean;
  /** 单次 LLM 调用的文本上限（字符），模型上下文大的可以调大 */
  maxChunkChars?: number;
}

export interface ChapterResult {
  chapters: ChapterItem[];
  /** B站章节文本 */
  chapterText: string;
  /** 置顶评论时间轴文本 */
  timelineText: string;
  duration: number;
  danmaku: DanmakuAnalysis | null;
}

interface ChapterConfig {
  /** 供应商类型，用于区分各家特有参数 */
  provider: "aliyun" | "openai" | "ffmpeg";
  asrModelId: string;
  llmModelId: string;
  apiKey: string;
  baseURL?: string;
  prompt: string;
  /** 单次 LLM 调用的文本上限（字符） */
  maxChunkChars: number;
  maxChapters: number;
  minChapterInterval: number;
  maxTitleLength: number;
  timelineWithHighlight: boolean;
}

const DEFAULT_CHAPTER_PROMPT = `
你是一名专业的直播录像内容编辑，负责把直播转写内容整理成 B站章节和置顶评论时间轴。

要求：
1. 章节标题要像观众熟悉的直播切片标题，简洁、有信息量，能体现这一段的具体内容。
2. 保留直播的话题转折、重大事件、名场面，标题尽量使用直播中的原话或弹幕里的说法。
3. 按时间顺序输出，不要编造素材里没有的内容。
`.trim();

/** 读取章节生成配置 */
function getChapterConfig(overrides: GenerateChaptersOptions): ChapterConfig {
  const config = appConfig.getAll();
  const data = config.ai;
  const chapterConfig = data?.chapterRecognize;

  const llmModelId = overrides.llmModelId || chapterConfig?.llmModelId;
  // 未指定时优先选已配置 key 的供应商下的模型，避免新手填了 key 还要再选一次
  const llmModels = (data?.models ?? []).filter((item) => item.tags?.includes("llm"));
  const fallbackModel =
    llmModels.find((item) => data.vendors.find((vendor) => vendor.id === item.vendorId)?.apiKey) ??
    llmModels[0];
  const resolvedModelId = llmModelId || fallbackModel?.modelId;
  if (!resolvedModelId) {
    throw new Error("请先在「设置 - AI配置」中添加并选择一个 LLM 模型");
  }
  const llmModel = getModel(resolvedModelId, config);
  const vendor = data.vendors.find((item) => item.id === llmModel.vendorId);
  if (!vendor) {
    throw new Error(`找不到 LLM 模型「${llmModel.modelName}」关联的供应商，请检查 AI 配置`);
  }
  // 本地推理服务（如 Ollama）可以不填 key
  const isLocalVendor = /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0)([:/]|$)/.test(
    vendor.baseURL ?? "",
  );
  if (!vendor.apiKey && !isLocalVendor) {
    throw new Error(
      `模型「${llmModel.modelName}」的供应商「${vendor.name}」还没有填写 API Key，请在「设置 - AI配置 - 供应商」中填写，或改选其他 LLM 模型`,
    );
  }

  const asrModelId =
    overrides.asrModelId || chapterConfig?.asrModelId || data?.subtitleRecognize?.modelId;
  if (!asrModelId) {
    throw new Error("请先在「设置 - AI配置 - 章节生成」中选择 ASR 模型");
  }

  return {
    provider: vendor.provider,
    asrModelId,
    llmModelId: llmModel.modelName,
    apiKey: vendor.apiKey,
    baseURL: vendor.baseURL,
    prompt: overrides.prompt || chapterConfig?.prompt || DEFAULT_CHAPTER_PROMPT,
    maxChunkChars: Math.max(2000, overrides.maxChunkChars ?? chapterConfig?.maxChunkChars ?? 6000),
    maxChapters: Math.max(2, overrides.maxChapters ?? chapterConfig?.maxChapters ?? 20),
    minChapterInterval: Math.max(
      5,
      overrides.minChapterInterval ?? chapterConfig?.minChapterInterval ?? 60,
    ),
    maxTitleLength: Math.max(2, overrides.maxTitleLength ?? chapterConfig?.maxTitleLength ?? 16),
    timelineWithHighlight:
      overrides.timelineWithHighlight ?? chapterConfig?.timelineWithHighlight ?? true,
  };
}

/** 提取音频，结果按视频 hash 缓存 */
async function extractAudio(videoFile: string, fileHash: string) {
  const cachePath = getTempPath();
  const audioPath = path.join(cachePath, `chapter_${fileHash}.mp3`);
  if (await fs.pathExists(audioPath)) {
    logger.info("命中音频缓存，跳过音频提取:", audioPath);
    return audioPath;
  }

  const task = await addExtractAudioTask(videoFile, path.basename(audioPath), {
    saveType: 2,
    savePath: cachePath,
    autoRun: true,
    addQueue: false,
    sampleRate: 16000,
    format: "libmp3lame",
    audioBitrate: "64k",
  });

  return new Promise<string>((resolve, reject) => {
    task.on("task-end", () => resolve(task.output as string));
    task.on("task-error", (err) => reject(err instanceof Error ? err : new Error(String(err))));
  });
}

/** ASR 识别，结果按视频 hash 与模型缓存，可复用字幕识别的缓存 */
async function recognizeTranscript(
  audioFile: string,
  asrModelId: string,
  fileHash: string,
): Promise<StandardASRResult> {
  const cachePath = getTempPath();
  const cacheFilePath = path.join(cachePath, `asr_chapter_cache_${fileHash}_${asrModelId}.json`);
  // 兼容字幕识别的缓存，避免重复识别
  const subtitleCachePath = path.join(
    cachePath,
    `asr_subtitle_cache_${fileHash}_${asrModelId}.json`,
  );

  for (const file of [cacheFilePath, subtitleCachePath]) {
    if (await fs.pathExists(file)) {
      try {
        logger.info("命中 ASR 缓存，跳过语音识别:", file);
        return (await fs.readJSON(file)) as StandardASRResult;
      } catch (error) {
        logger.warn("ASR 缓存读取失败，将重新识别", error);
      }
    }
  }

  const result = await recognize(audioFile, asrModelId);
  await fs.writeJSON(cacheFilePath, result, { spaces: 2 });
  logger.info("ASR 结果已缓存到:", cacheFilePath);
  return result;
}

interface CandidateTopic {
  time: number;
  topic: string;
}

/**
 * 创建 LLM 调用方法
 * enable_search / enable_thinking 是阿里云特有参数，其他 OpenAI 兼容服务（DeepSeek 等）不能带，
 * 否则可能报未知参数
 */
function createChatJson(config: ChapterConfig) {
  const llm = new QwenLLM({
    apiKey: config.apiKey,
    model: config.llmModelId,
    baseURL: config.baseURL,
  });
  const nativeOptions =
    config.provider === "aliyun" ? { enableSearch: false, enableThinking: false } : {};

  return async function chatJson<T>(systemPrompt: string, userContent: string): Promise<T> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await llm.sendMessage(userContent, systemPrompt, {
        temperature: 0.3,
        responseFormat: { type: "json_object" },
        ...nativeOptions,
      });
      if (!response.content) {
        lastError = new Error("LLM 未返回任何内容");
        continue;
      }
      try {
        return parseLlmJson<T>(response.content);
      } catch (error) {
        lastError = error;
        logger.warn("LLM 返回内容解析失败，重试中", error);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("LLM 返回内容解析失败");
  };
}

/** 找到最接近的转写文本行，避免章节时间戳落在两句话中间 */
function snapToTranscript(time: number, lineStarts: number[], duration: number, tolerance = 15) {
  let nearest = time;
  let nearestDistance = tolerance;
  for (const start of lineStarts) {
    const distance = Math.abs(start - time);
    if (distance < nearestDistance) {
      nearest = start;
      nearestDistance = distance;
    }
  }
  return Math.min(Math.max(nearest, 0), duration);
}

function cleanTitle(title: string, maxTitleLength: number) {
  const cleaned = String(title ?? "")
    .replace(/^\s*\d+[.、)）:：]\s*/, "")
    .replace(/[\s。，,；;：:！!？?]+$/, "")
    .trim();
  return cleaned.slice(0, maxTitleLength) || "未命名章节";
}

/** 章节后处理：对齐时间、限制数量与标题长度 */
function postProcessChapters(
  rawChapters: { time: string | number; title: string }[],
  context: {
    lines: TranscriptLine[];
    duration: number;
    maxChapters: number;
    minChapterInterval: number;
    maxTitleLength: number;
    danmaku: DanmakuAnalysis | null;
  },
): ChapterItem[] {
  const { lines, duration, maxChapters, minChapterInterval, maxTitleLength, danmaku } = context;
  const lineStarts = lines.map((line) => line.start);

  const chapters = rawChapters
    .map((item) => ({
      start: parseTimeToSeconds(item.time),
      title: cleanTitle(item.title, maxTitleLength),
    }))
    .filter((item) => item.start >= 0)
    .sort((a, b) => a.start - b.start)
    .map((item) => ({
      ...item,
      start: snapToTranscript(item.start, lineStarts, duration),
    }));

  // 首章对齐到 00:00
  if (chapters.length > 0) {
    if (chapters[0].start > 30) {
      chapters.unshift({ start: 0, title: "开场" });
    } else {
      chapters[0].start = 0;
    }
  }

  // 去掉间隔过近的章节
  const merged: typeof chapters = [];
  for (const chapter of chapters) {
    const last = merged[merged.length - 1];
    if (last && chapter.start - last.start < minChapterInterval) continue;
    merged.push(chapter);
  }

  const maxScore = Math.max(0, ...(danmaku?.spots ?? []).map((spot) => spot.score));
  const isHighlight = (start: number, end: number) => {
    if (!danmaku || maxScore <= 0) return false;
    return danmaku.spots.some(
      (spot) => spot.time >= start - 5 && spot.time < end + 5 && spot.score >= maxScore * 0.5,
    );
  };

  const withTime = merged.map((chapter, index) => {
    const next = merged[index + 1];
    return {
      start: chapter.start,
      end: next ? next.start : duration,
      title: chapter.title,
      highlight: false,
    };
  });

  // 超出数量上限时，优先去掉弹幕热度最低的章节
  while (withTime.length > maxChapters && withTime.length > 2) {
    let dropIndex = 1;
    let lowestScore = Number.POSITIVE_INFINITY;
    for (let i = 1; i < withTime.length; i++) {
      const chapter = withTime[i];
      const score = (danmaku?.density ?? [])
        .filter((item) => item.time >= chapter.start && item.time < chapter.end)
        .reduce((total, item) => total + item.count, 0);
      if (score < lowestScore) {
        lowestScore = score;
        dropIndex = i;
      }
    }
    withTime.splice(dropIndex, 1);
    withTime.forEach((chapter, index) => {
      chapter.end = withTime[index + 1]?.start ?? duration;
    });
  }

  return withTime.map((chapter) => ({
    ...chapter,
    highlight: isHighlight(chapter.start, chapter.end),
  }));
}

/** 秒 -> 视频内使用的时间文本，超过 1 小时用 hh:mm:ss */
function formatTime(seconds: number, withHours: boolean) {
  if (withHours) return formatTimestamp(seconds);
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** 生成 B站章节文本 */
export function formatChapterText(chapters: ChapterItem[], duration: number) {
  const withHours = duration >= 3600;
  return chapters
    .map((chapter) => `${formatTime(chapter.start, withHours)} ${chapter.title}`)
    .join("\n");
}

/** 生成置顶评论时间轴文本 */
export function formatTimelineText(
  chapters: ChapterItem[],
  options: { duration: number; danmaku?: DanmakuAnalysis | null; withHighlight?: boolean },
) {
  const withHours = options.duration >= 3600;
  const entries: { time: number; text: string }[] = chapters.map((chapter) => ({
    time: chapter.start,
    text: `${formatTime(chapter.start, withHours)} ${chapter.title}${chapter.highlight ? " 🔥" : ""}`,
  }));

  if (options.withHighlight && options.danmaku) {
    const maxScore = Math.max(0, ...options.danmaku.spots.map((spot) => spot.score));
    const usedTimes = chapters.map((chapter) => chapter.start);
    let added = 0;
    for (const spot of options.danmaku.spots) {
      if (added >= 20) break;
      if (maxScore <= 0 || spot.score < maxScore * 0.5) continue;
      // 与章节时间过近的高能点不重复展示
      if (usedTimes.some((time) => Math.abs(time - spot.time) < 60)) continue;
      const title = spot.keywords.length > 0 ? spot.keywords.slice(0, 3).join("、") : "高能时刻";
      entries.push({
        time: spot.time,
        text: `${formatTime(spot.time, withHours)} 🔥 ${title}（弹幕${spot.count}条）`,
      });
      usedTimes.push(spot.time);
      added++;
    }
  }

  const lines = entries.sort((a, b) => a.time - b.time).map((entry) => entry.text);
  return ["📌 时间轴", ...lines].join("\n");
}

/**
 * 分析视频与弹幕，生成 B站章节和置顶评论时间轴
 */
export async function generateChapters(options: GenerateChaptersOptions): Promise<ChapterResult> {
  const { videoFile, danmuFile, onProgress, isCanceled } = options;
  const progress = (stage: string, percentage: number, message: string) => {
    logger.info(`[章节生成] ${message}`);
    onProgress?.({ stage, percentage, message });
  };
  const assertNotCanceled = () => {
    if (isCanceled?.()) throw new Error("任务已取消");
  };

  if (!(await fs.pathExists(videoFile))) {
    throw new Error(`视频文件不存在：${videoFile}`);
  }
  if (danmuFile && !(await fs.pathExists(danmuFile))) {
    throw new Error(`弹幕文件不存在：${danmuFile}`);
  }

  const config = getChapterConfig(options);

  progress("prepare", 2, "开始分析视频");
  const fileHash = await calculateFileQuickHash(videoFile);

  // 1. 弹幕分析
  let danmaku: DanmakuAnalysis | null = null;
  if (danmuFile) {
    progress("danmaku", 5, "解析弹幕文件");
    danmaku = await analyzeDanmaku(danmuFile);
  }

  // 2. 音频提取 + ASR
  assertNotCanceled();
  const asrCachePath = path.join(
    getTempPath(),
    `asr_chapter_cache_${fileHash}_${config.asrModelId}.json`,
  );
  const subtitleCachePath = path.join(
    getTempPath(),
    `asr_subtitle_cache_${fileHash}_${config.asrModelId}.json`,
  );
  let asrResult: StandardASRResult | null = null;
  if ((await fs.pathExists(asrCachePath)) || (await fs.pathExists(subtitleCachePath))) {
    progress("asr", 25, "命中语音识别缓存");
  } else {
    progress("audio", 8, "提取音频");
    const audioFile = await extractAudio(videoFile, fileHash);
    assertNotCanceled();
    progress("asr", 20, "识别语音（耗时较长，请耐心等待）");
    asrResult = await recognizeTranscript(audioFile, config.asrModelId, fileHash);
  }

  if (!asrResult) {
    const cacheFile = (await fs.pathExists(asrCachePath)) ? asrCachePath : subtitleCachePath;
    asrResult = (await fs.readJSON(cacheFile)) as StandardASRResult;
  }

  const lines = buildTranscriptLines(asrResult.segments ?? []);
  if (lines.length === 0) {
    throw new Error("语音识别结果为空，无法生成章节");
  }
  const duration = Math.max(
    asrResult.duration ?? 0,
    lines[lines.length - 1].end,
    danmaku?.duration ?? 0,
  );
  progress("asr", 55, `语音识别完成，共 ${lines.length} 行文本`);

  // 3. LLM 分段
  assertNotCanceled();
  const chatJson = createChatJson(config);
  const danmakuText = danmaku ? formatDanmakuForPrompt(danmaku) : "";
  const chunks = chunkTranscriptLines(lines, { maxChars: config.maxChunkChars });
  let topics: CandidateTopic[] = [];
  const singlePass = chunks.length === 1;

  if (!singlePass) {
    for (let i = 0; i < chunks.length; i++) {
      assertNotCanceled();
      progress(
        "llm",
        55 + Math.round(((i + 1) / chunks.length) * 30),
        `分析第 ${i + 1}/${chunks.length} 段内容`,
      );
      const chunk = chunks[i];
      const chunkStart = chunk[0].start;
      const chunkEnd = chunk[chunk.length - 1].end;
      const chunkDanmaku = danmaku
        ? formatDanmakuForPrompt({
            ...danmaku,
            spots: danmaku.spots.filter(
              (spot) => spot.time >= chunkStart - 60 && spot.time <= chunkEnd + 60,
            ),
            paidEvents: danmaku.paidEvents.filter(
              (event) => event.time >= chunkStart - 60 && event.time <= chunkEnd + 60,
            ),
          })
        : "";

      const userContent = [
        `视频总时长：${formatTimestamp(duration)}`,
        danmakuText ? `本片段的弹幕高能点参考：\n${chunkDanmaku}` : "",
        `本片段的转写文本（时间为整个视频的时间）：\n${formatTranscriptLines(chunk)}`,
        "请划分本片段内的话题，输出 JSON。",
      ]
        .filter(Boolean)
        .join("\n\n");

      const result = await chatJson<{ topics?: { time: string | number; topic: string }[] }>(
        CHUNK_SYSTEM_PROMPT,
        userContent,
      );

      const parsed = (result.topics ?? [])
        .map((item) => ({
          time: parseTimeToSeconds(item.time),
          topic: String(item.topic ?? "").trim(),
        }))
        .filter((item) => item.time >= 0 && item.topic);
      topics.push(...parsed);
    }

    // 去重并按时间排序
    topics.sort((a, b) => a.time - b.time);
    const deduped: CandidateTopic[] = [];
    for (const topic of topics) {
      const last = deduped[deduped.length - 1];
      if (last && topic.time - last.time < 30) continue;
      deduped.push(topic);
    }
    topics = deduped;
  }

  assertNotCanceled();
  progress("llm", 88, "汇总章节");
  const mergeUserContent = [
    `视频总时长：${formatTimestamp(duration)}`,
    singlePass
      ? `转写文本：\n${formatTranscriptLines(lines)}`
      : `候选话题：\n${topics
          .map((topic) => `${formatTimestamp(topic.time)} ${topic.topic}`)
          .join("\n")}`,
    danmakuText ? `弹幕高能点：\n${danmakuText}` : "",
    buildMergeRequirement({
      duration,
      maxChapters: config.maxChapters,
      minChapterInterval: config.minChapterInterval,
      maxTitleLength: config.maxTitleLength,
    }),
  ]
    .filter(Boolean)
    .join("\n\n");

  const merged = await chatJson<{ chapters?: { time: string | number; title: string }[] }>(
    config.prompt,
    mergeUserContent,
  );

  const rawChapters = merged.chapters ?? [];
  if (rawChapters.length === 0) {
    throw new Error("LLM 未生成任何章节，请调整提示词或更换模型后重试");
  }

  progress("format", 95, "整理章节");
  const chapters = postProcessChapters(rawChapters, {
    lines,
    duration,
    maxChapters: config.maxChapters,
    minChapterInterval: config.minChapterInterval,
    maxTitleLength: config.maxTitleLength,
    danmaku,
  });
  if (chapters.length === 0) {
    throw new Error("未能整理出有效章节，请调整提示词或更换模型后重试");
  }

  const result: ChapterResult = {
    chapters,
    chapterText: formatChapterText(chapters, duration),
    timelineText: formatTimelineText(chapters, {
      duration,
      danmaku,
      withHighlight: config.timelineWithHighlight,
    }),
    duration,
    danmaku,
  };

  logger.info("章节生成完成", { chapters: chapters.length, duration });
  progress("done", 100, "章节生成完成");
  return result;
}
