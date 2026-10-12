import { musicDetect } from "../musicDetector/index.js";
import logger from "../utils/log.js";
import { formatTimestamp } from "./danmaku.js";

import type { StandardASRResult } from "../ai/asr/types.js";
import type { DanmakuAnalysis } from "./danmaku.js";

/** 唱歌/音乐片段 */
export interface SingingSegment {
  /** 开始时间（秒） */
  start: number;
  /** 结束时间（秒） */
  end: number;
  /** 置信度 0-1 */
  confidence: number;
  /** 歌名，可能为空 */
  name?: string;
  /** 判定依据 */
  sources: ("audio" | "asr" | "danmaku" | "llm")[];
}

export interface SingingDetectOptions {
  /** 视频文件路径 */
  videoFile: string;
  /** ASR 结果，用于读取 bcut 的 music 分数与歌词文本 */
  asrResult?: StandardASRResult | null;
  /** 弹幕分析结果，用于佐证 */
  danmaku?: DanmakuAnalysis | null;
  /** 片段最短时长（秒），默认 20 */
  minDuration?: number;
  /** 小于这个间隔的片段合并，默认 15 秒 */
  mergeGap?: number;
  /** ASR music 分数阈值，默认 0.5 */
  musicThreshold?: number;
  /** 用 LLM 复核候选片段，可一次调用完成判定与命名 */
  review?: (
    candidates: { start: number; end: number; text: string }[],
  ) => Promise<{ index: number; isSinging: boolean; name?: string; confidence?: number }[]>;
  /** 检测唱歌时是否让 LLM 猜歌名 */
  recognizeMusicName?: boolean;
  onProgress?: (data: { stage: string; percentage: number; message: string }) => void;
}

/** 唱歌片段常见的弹幕关键词 */
const SINGING_KEYWORDS = [
  "唱歌",
  "好听",
  "歌名",
  "歌回",
  "点歌",
  "开唱",
  "唱得",
  "awsl",
  "安可",
  "encore",
  "天籁",
  "海豚音",
  "破音",
  "翻唱",
  "高音",
];

interface RawCandidate {
  start: number;
  end: number;
  confidence: number;
  sources: SingingSegment["sources"];
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

/** 读取 bcut ASR 的 music 分数，把连续的唱歌句子合并成候选片段 */
export function collectAsrCandidates(
  asrResult: StandardASRResult | null | undefined,
  options?: { minDuration?: number; musicThreshold?: number; maxGap?: number },
): RawCandidate[] {
  const minDuration = options?.minDuration ?? 20;
  const musicThreshold = options?.musicThreshold ?? 0.5;
  const maxGap = options?.maxGap ?? 10;
  const segments = (asrResult?.segments ?? []).filter(
    (segment) => typeof segment.music === "number" && segment.music! >= musicThreshold,
  );
  if (segments.length === 0) return [];

  const candidates: RawCandidate[] = [];
  let current: { start: number; end: number; music: number[] } | null = null;

  for (const segment of segments) {
    if (!current) {
      current = { start: segment.start, end: segment.end, music: [segment.music!] };
      continue;
    }
    if (segment.start - current.end <= maxGap) {
      current.end = segment.end;
      current.music.push(segment.music!);
      continue;
    }
    candidates.push({
      start: current.start,
      end: current.end,
      confidence: current.music.reduce((total, value) => total + value, 0) / current.music.length,
      sources: ["asr"],
    });
    current = { start: segment.start, end: segment.end, music: [segment.music!] };
  }
  if (current) {
    candidates.push({
      start: current.start,
      end: current.end,
      confidence: current.music.reduce((total, value) => total + value, 0) / current.music.length,
      sources: ["asr"],
    });
  }

  return candidates.filter((candidate) => candidate.end - candidate.start >= minDuration);
}

/** 合并重叠或过近的候选片段 */
function mergeCandidates(candidates: RawCandidate[], mergeGap: number): RawCandidate[] {
  const sorted = [...candidates].sort((a, b) => a.start - b.start);
  const merged: RawCandidate[] = [];

  for (const candidate of sorted) {
    const last = merged[merged.length - 1];
    if (!last || candidate.start - last.end > mergeGap) {
      merged.push({ ...candidate, sources: [...candidate.sources] });
      continue;
    }
    const overlap = Math.min(last.end, candidate.end) - Math.max(last.start, candidate.start);
    const shortSide = Math.min(last.end - last.start, candidate.end - candidate.start);
    // 重叠比例高的直接合并，并取更高的置信度
    if (overlap > 0 && overlap / Math.max(shortSide, 1) > 0.5) {
      last.start = Math.min(last.start, candidate.start);
      last.end = Math.max(last.end, candidate.end);
      last.confidence = Math.max(last.confidence, candidate.confidence + 0.05);
      candidate.sources.forEach((source) => {
        if (!last.sources.includes(source)) last.sources.push(source);
      });
    } else {
      merged.push({ ...candidate, sources: [...candidate.sources] });
    }
  }

  return merged;
}

/** 用弹幕关键词给候选片段加分 */
function scoreByDanmaku(candidate: RawCandidate, danmaku: DanmakuAnalysis) {
  const texts = danmaku.spots.flatMap((spot) =>
    spot.time >= candidate.start && spot.time < candidate.end ? spot.keywords : [],
  );
  const hit = texts.some((keyword) => SINGING_KEYWORDS.some((word) => keyword.includes(word)));
  if (!hit) return;
  candidate.confidence = clamp(candidate.confidence + 0.1, 0, 1);
  if (!candidate.sources.includes("danmaku")) candidate.sources.push("danmaku");
}

/** 取得片段内的 ASR 文本，供 LLM 判定 */
function collectText(asrResult: StandardASRResult | null | undefined, start: number, end: number) {
  return (asrResult?.segments ?? [])
    .filter((segment) => segment.start < end && segment.end > start)
    .map((segment) => segment.text)
    .join("")
    .slice(0, 400);
}

/**
 * 综合多路信号检测唱歌片段：
 * 1. 音频特征（本地，music-segment-detector）
 * 2. bcut ASR 的 music 分数
 * 3. 弹幕关键词佐证
 * 4. LLM 复核（可选，一次调用完成判定与命名）
 */
export async function detectSingingSegments(
  options: SingingDetectOptions,
): Promise<SingingSegment[]> {
  const minDuration = options?.minDuration ?? 20;
  const mergeGap = options?.mergeGap ?? 15;
  const musicThreshold = options?.musicThreshold ?? 0.5;
  const progress = options.onProgress;

  const candidates: RawCandidate[] = [];

  // 信号 1：音频特征检测
  try {
    progress?.({ stage: "singing-audio", percentage: 0, message: "分析音频特征，检测唱歌片段" });
    const segments = await musicDetect(options.videoFile, {
      minSegmentDuration: Math.max(10, minDuration),
      maxGapDuration: Math.max(10, mergeGap),
    });
    for (const segment of segments) {
      candidates.push({
        start: segment.startTime,
        end: segment.endTime,
        confidence: clamp(Number(segment.confidence) || 0.6, 0, 1),
        sources: ["audio"],
      });
    }
    progress?.({
      stage: "singing-audio",
      percentage: 100,
      message: `音频特征检测到 ${segments.length} 个疑似片段`,
    });
  } catch (error) {
    // 音频分析失败（例如缺少 ffmpeg）不阻塞流程，退回 ASR 信号
    logger.warn("音频特征检测失败，仅使用 ASR 信号判断唱歌", error);
  }

  // 信号 2：ASR music 分数
  candidates.push(
    ...collectAsrCandidates(options.asrResult, { minDuration, musicThreshold, maxGap: 10 }),
  );

  if (candidates.length === 0) {
    return [];
  }

  let merged = mergeCandidates(candidates, mergeGap);

  // 信号 3：弹幕佐证
  if (options.danmaku) {
    merged.forEach((candidate) => scoreByDanmaku(candidate, options.danmaku!));
  }

  // 信号 4：LLM 复核，同时可以猜歌名
  if (options.review) {
    try {
      progress?.({ stage: "singing-llm", percentage: 0, message: "复核唱歌片段" });
      const reviews = await options.review(
        merged.map((candidate, index) => ({
          start: candidate.start,
          end: candidate.end,
          text: collectText(options.asrResult, candidate.start, candidate.end),
        })),
      );
      const reviewed: RawCandidate[] = [];
      for (const [index, candidate] of merged.entries()) {
        const result = reviews.find((item) => item.index === index);
        if (!result) {
          reviewed.push(candidate);
          continue;
        }
        if (!result.isSinging) continue;
        const next: RawCandidate & { name?: string } = {
          ...candidate,
          confidence: clamp(result.confidence ?? candidate.confidence, 0, 1),
          sources: candidate.sources.includes("llm")
            ? candidate.sources
            : [...candidate.sources, "llm"],
          name: result.name,
        };
        reviewed.push(next);
      }
      merged = reviewed;
      progress?.({
        stage: "singing-llm",
        percentage: 100,
        message: `复核后保留 ${merged.length} 个片段`,
      });
    } catch (error) {
      logger.warn("LLM 复核唱歌片段失败，使用原始检测结果", error);
    }
  }

  return merged
    .filter((candidate) => candidate.end - candidate.start >= minDuration)
    .map((candidate) => ({
      start: candidate.start,
      end: candidate.end,
      confidence: clamp(candidate.confidence, 0, 1),
      sources: candidate.sources,
      ...(options.recognizeMusicName && (candidate as RawCandidate & { name?: string }).name
        ? { name: (candidate as RawCandidate & { name?: string }).name }
        : {}),
    }))
    .sort((a, b) => a.start - b.start);
}

/** 生成给 LLM 的唱歌片段文本 */
export function formatSingingForPrompt(segments: SingingSegment[]) {
  if (segments.length === 0) return "";
  const lines = segments.map((segment) => {
    const duration = Math.round(segment.end - segment.start);
    const name = segment.name ? `，可能是《${segment.name}》` : "";
    return `${formatTimestamp(segment.start)}-${formatTimestamp(segment.end)}（${duration}秒，置信度 ${segment.confidence.toFixed(2)}${name}）`;
  });
  return `检测到的唱歌片段：\n${lines.join("\n")}`;
}
