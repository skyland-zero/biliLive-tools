import { formatTimestamp } from "./danmaku.js";

import type { DanmakuAnalysis } from "./danmaku.js";
import type { SingingSegment } from "./singing.js";

/** 时间轴事件类型 */
export type TimelineEventType = "topic" | "highlight" | "singing";

/** 统一的时间轴事件，章节和置顶评论都从这里渲染 */
export interface TimelineEvent {
  type: TimelineEventType;
  /** 开始时间（秒） */
  start: number;
  /** 结束时间（秒），点事件为空 */
  end?: number;
  /** 展示标题 */
  title: string;
  /** 重要性 0-1，用于条目取舍 */
  score: number;
  /** 话题章节是否为弹幕高能章节 */
  highlight?: boolean;
  /** 唱歌事件的歌名 */
  musicName?: string;
  /** 高能事件的热点词 */
  keywords?: string[];
  /** 附加说明，例如弹幕条数 */
  detail?: string;
}

/** 章节数据（从事件流的主干而来） */
export interface ChapterLike {
  start: number;
  end: number;
  title: string;
  highlight: boolean;
  musicName?: string;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

/**
 * 把主干章节、弹幕高能、唱歌片段合并成统一事件流
 * 与章节起点过近的点事件会被章节吸收，不再重复展示
 */
export function buildTimelineEvents(options: {
  chapters: ChapterLike[];
  danmaku: DanmakuAnalysis | null;
  singing: SingingSegment[];
  /** 点事件与章节起点的合并容差（秒），默认 30 */
  topicTolerance?: number;
}): TimelineEvent[] {
  const { chapters, danmaku, singing } = options;
  const tolerance = options.topicTolerance ?? 30;

  const events: TimelineEvent[] = chapters.map((chapter) => ({
    type: "topic" as const,
    start: chapter.start,
    end: chapter.end,
    title: chapter.title,
    score: 1,
    highlight: chapter.highlight,
    musicName: chapter.musicName,
  }));

  const nearTopic = (time: number) =>
    chapters.some((chapter) => Math.abs(chapter.start - time) <= tolerance);

  // 弹幕高能点
  const spots = danmaku?.spots ?? [];
  const maxSpotScore = spots.reduce((max, spot) => Math.max(max, spot.score), 0);
  if (maxSpotScore > 0) {
    for (const spot of spots) {
      if (nearTopic(spot.time)) continue;
      events.push({
        type: "highlight",
        start: spot.time,
        title: spot.keywords.slice(0, 3).join("、") || "高能时刻",
        score: spot.score / maxSpotScore,
        keywords: spot.keywords,
        detail: `弹幕${spot.count}条`,
      });
    }
  }

  // 唱歌片段
  for (const segment of singing) {
    if (nearTopic(segment.start)) continue;
    events.push({
      type: "singing",
      start: segment.start,
      end: segment.end,
      title: segment.name ? `唱歌《${segment.name}》` : "唱歌",
      // 唱歌比一般高能更值得保留
      score: clamp(segment.confidence + 0.3, 0, 1),
      musicName: segment.name,
      detail: `${Math.max(1, Math.round((segment.end - segment.start) / 60))} 分钟`,
    });
  }

  return events.sort((a, b) => a.start - b.start);
}

function formatTime(seconds: number, withHours: boolean) {
  if (withHours) return formatTimestamp(seconds);
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** 单条事件的展示文本 */
export function renderTimelineEvent(event: TimelineEvent, withHours: boolean) {
  const time = formatTime(event.start, withHours);
  if (event.type === "highlight") {
    return `${time} 🔥 ${event.title}${event.detail ? `（${event.detail}）` : ""}`;
  }
  if (event.type === "singing") {
    return `${time} 🎤 ${event.title}${event.detail ? `（${event.detail}）` : ""}`;
  }
  // 歌名已在标题里时不再重复展示
  const music = event.musicName
    ? event.title.includes(event.musicName)
      ? " 🎤"
      : ` 🎤《${event.musicName}》`
    : "";
  const hot = event.highlight ? " 🔥" : "";
  return `${time} ${event.title}${music}${hot}`;
}

export interface TimelineRenderOptions {
  duration: number;
  /** 条目上限，0 或省略表示不限 */
  maxItems?: number;
  /** 总字数上限，0 或省略表示不限 */
  maxChars?: number;
}

/**
 * 渲染置顶评论时间轴。
 * 主干章节必选，高能/唱歌按重要性补入，受条数与字数预算约束
 */
export function renderTimelineText(events: TimelineEvent[], options: TimelineRenderOptions) {
  const withHours = options.duration >= 3600;
  const maxItems = options.maxItems ?? 0;
  const maxChars = options.maxChars ?? 0;

  const topics = events.filter((event) => event.type === "topic");
  const optional = events
    .filter((event) => event.type !== "topic")
    .sort((a, b) => b.score - a.score);

  const selected = [...topics];
  const measure = (items: TimelineEvent[]) =>
    [
      "📌 时间轴",
      ...items
        .sort((a, b) => a.start - b.start)
        .map((event) => renderTimelineEvent(event, withHours)),
    ].join("\n").length;

  for (const event of optional) {
    if (maxItems > 0 && selected.length >= maxItems) break;
    if (maxChars > 0 && measure([...selected, event]) > maxChars) continue;
    selected.push(event);
  }

  const lines = selected
    .sort((a, b) => a.start - b.start)
    .map((event) => renderTimelineEvent(event, withHours));
  return ["📌 时间轴", ...lines].join("\n");
}

/** 渲染 B站章节文本 */
export function renderChapterText(chapters: ChapterLike[], duration: number) {
  const withHours = duration >= 3600;
  return chapters
    .map((chapter) => `${formatTime(chapter.start, withHours)} ${chapter.title}`)
    .join("\n");
}
