import type { StandardASRSegment } from "../ai/asr/types.js";
import { formatTimestamp } from "./danmaku.js";

/** 带时间戳的转写文本行 */
export interface TranscriptLine {
  /** 开始时间（秒） */
  start: number;
  /** 结束时间（秒） */
  end: number;
  text: string;
}

/**
 * 把 ASR 句子合并成更自然的文本行。
 * 合并规则：达到长度上限，或者两句话之间间隔过大且当前行已经足够长
 */
export function buildTranscriptLines(
  segments: StandardASRSegment[],
  options?: {
    /** 单行最大字数，默认 50 */
    maxLineChars?: number;
    /** 断句的最小字符数，默认 12 */
    minLineChars?: number;
    /** 触发断句的静默时长（秒），默认 3 */
    gapSeconds?: number;
  },
): TranscriptLine[] {
  const maxLineChars = options?.maxLineChars ?? 50;
  const minLineChars = options?.minLineChars ?? 12;
  const gapSeconds = options?.gapSeconds ?? 3;

  const lines: TranscriptLine[] = [];
  let current: TranscriptLine | null = null;

  for (const segment of segments) {
    const text = String(segment.text ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;

    if (!current) {
      current = { start: segment.start, end: segment.end, text };
      continue;
    }

    const gap = segment.start - current.end;
    const tooLong = current.text.length + text.length > maxLineChars;
    const shouldBreak = tooLong || (gap >= gapSeconds && current.text.length >= minLineChars);

    if (shouldBreak) {
      lines.push(current);
      current = { start: segment.start, end: segment.end, text };
    } else {
      current.text += text;
      current.end = segment.end;
    }
  }
  if (current) lines.push(current);

  return lines;
}

/** 按字符预算切分转写文本，块之间保留少量重叠 */
export function chunkTranscriptLines(
  lines: TranscriptLine[],
  options?: {
    /** 单块最大字符数，默认 6000 */
    maxChars?: number;
    /** 块之间重叠的行数，默认 2 */
    overlapLines?: number;
  },
): TranscriptLine[][] {
  const maxChars = options?.maxChars ?? 6000;
  const overlapLines = options?.overlapLines ?? 2;

  const sizeOf = (line: TranscriptLine) => line.text.length + 12;

  const chunks: TranscriptLine[][] = [];
  let current: TranscriptLine[] = [];
  let currentSize = 0;

  for (const line of lines) {
    const size = sizeOf(line);
    if (current.length > 0 && currentSize + size > maxChars) {
      chunks.push(current);
      current = current.slice(Math.max(0, current.length - overlapLines));
      currentSize = current.reduce((total, item) => total + sizeOf(item), 0);
    }
    current.push(line);
    currentSize += size;
  }
  if (current.length > 0) chunks.push(current);

  return chunks;
}

/** 格式化转写文本，行首带时间戳 */
export function formatTranscriptLines(lines: TranscriptLine[]) {
  return lines.map((line) => `[${formatTimestamp(line.start)}] ${line.text}`).join("\n");
}

/** 从 LLM 返回内容中提取 JSON */
export function parseLlmJson<T>(content: string): T {
  let text = content.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) text = fenceMatch[1].trim();

  const startIndex = text.search(/[[{]/);
  const endIndex = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    throw new Error("LLM 返回内容不是 JSON");
  }
  return JSON.parse(text.slice(startIndex, endIndex + 1)) as T;
}

/** 解析 LLM 返回的时间，支持 hh:mm:ss / mm:ss / 秒数 */
export function parseTimeToSeconds(input: string | number): number {
  if (typeof input === "number") return Math.max(0, Math.floor(input));
  const text = String(input ?? "").trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Math.max(0, Math.floor(Number(text)));

  const parts = text.split(":").map((part) => Number(part.trim()));
  if (parts.some((part) => !Number.isFinite(part))) return -1;

  if (parts.length === 3) {
    const [h, m, s] = parts;
    return Math.max(0, Math.floor(h * 3600 + m * 60 + s));
  }
  if (parts.length === 2) {
    const [m, s] = parts;
    return Math.max(0, Math.floor(m * 60 + s));
  }
  return -1;
}

/** 每块视频段落的初筛提示词 */
export const CHUNK_SYSTEM_PROMPT = `
你是一名专业的直播录像内容编辑，擅长把长篇直播的转写文本按话题切分成若干段落。

要求：
1. 只根据给出的文本内容划分，不要编造时间点，所有时间必须来自文本行首的时间戳。
2. 一段话题通常持续 3~15 分钟，不要切得过碎，也不要把明显不同的话题合并在一起。
3. 不要因为文本从一个片段的开头开始就新增一个话题，除非它确实是新话题的起点。
4. 每段输出一句简短描述（不超过 25 字），概括这段内容，尽量使用原文里的说法。
5. 如果给出了唱歌片段，唱歌的起点通常是一个新话题的起点，请单独分段。
6. 输出 JSON，格式：{"topics":[{"time":"hh:mm:ss","topic":"描述"}]}，除 JSON 外不要输出任何内容。
`.trim();

/** 汇总章节的补充要求 */
export function buildMergeRequirement(options: {
  duration: number;
  maxChapters: number;
  minChapterInterval: number;
  maxTitleLength: number;
  /** 是否检测到唱歌片段 */
  hasSinging?: boolean;
}) {
  return [
    `视频总时长：${formatTimestamp(options.duration)}`,
    "要求：",
    `1. 最多输出 ${options.maxChapters} 个章节，章节太少或太多都不合适，请优先保留话题切换明显、弹幕高能的位置。`,
    "2. 第一个章节必须从 00:00:00 开始。",
    `3. 相邻章节的时间间隔不小于 ${options.minChapterInterval} 秒。`,
    `4. 章节标题不超过 ${options.maxTitleLength} 个字，不要以标点结尾，不要带序号。`,
    "5. 分界点优先落在大弹幕峰值、重要付费互动事件或明显的话题切换处。",
    options.hasSinging
      ? "6. 唱歌片段的起点必须成为一个章节边界，该章节标题用「唱歌：歌名」开头，判断不出歌名就只写「唱歌」，不要编造歌名。"
      : "",
    `${options.hasSinging ? "7" : "6"}. 输出 JSON，格式：{\"chapters\":[{\"time\":\"hh:mm:ss\",\"title\":\"标题\"}]}，除 JSON 外不要输出任何内容。`,
  ]
    .filter(Boolean)
    .join("\n");
}
