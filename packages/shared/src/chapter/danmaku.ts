import { parseDanmu } from "../danmu/index.js";
import logger from "../utils/log.js";

/** 弹幕高能点 */
export interface DanmakuSpot {
  /** 时间（秒） */
  time: number;
  /** 窗口内弹幕数 */
  count: number;
  /** 综合得分，弹幕数 + 付费互动加权 */
  score: number;
  /** 高频弹幕词 */
  keywords: string[];
  /** 付费互动事件 */
  events: string[];
}

/** 付费互动事件 */
export interface DanmakuPaidEvent {
  /** 时间（秒） */
  time: number;
  /** 事件描述 */
  text: string;
  /** 事件权重 */
  weight: number;
}

export interface DanmakuAnalysis {
  /** 弹幕总数 */
  total: number;
  /** 付费事件数 */
  paidCount: number;
  /** 弹幕最大时间（秒） */
  duration: number;
  /** 密度序列，按 interval 聚合 */
  density: { time: number; count: number }[];
  /** 高能点，按时间排序 */
  spots: DanmakuSpot[];
  /** 付费互动事件，按时间排序 */
  paidEvents: DanmakuPaidEvent[];
}

export interface DanmakuAnalysisOptions {
  /** 密度聚合间隔，默认 10 秒 */
  interval?: number;
  /** 峰值统计窗口，默认 60 秒 */
  windowSize?: number;
  /** 最多返回的高能点数量，默认 30 */
  maxSpots?: number;
  /** 每个高能点的关键词数量，默认 8 */
  keywordsPerSpot?: number;
  /** 两个高能点之间的最小间隔，默认 windowSize * 2 */
  minSpotDistance?: number;
  /** 参与关键词统计的弹幕条数上限，默认 3000 */
  maxKeywordSample?: number;
}

const STOP_WORDS = new Set([
  "哈哈",
  "哈哈哈",
  "哈哈哈哈",
  "233",
  "2333",
  "23333",
  "666",
  "6666",
  "66666",
  "啊啊啊",
  "呜呜呜",
  "前排",
  "来了",
  "来了来了",
  "打卡",
  "第一",
  "不知道",
  "什么",
  "这是",
  "这个",
  "那个",
  "可以",
  "没有",
  "就是",
  "不是",
  "真的",
  "哈哈哈哈哈",
  "笑死",
  "哈哈哈嗝",
  "主播",
  "老板",
  "谢谢",
  "感谢",
  "哈哈！",
  "哈哈哈！",
  "hhhh",
  "hhhhh",
  "围观",
  "路过",
  "打卡打卡",
  "nice",
  "nb",
  "NB",
  "加油",
]);

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function percentile(data: number[], p: number) {
  if (data.length === 0) return 0;
  const sorted = [...data].sort((a, b) => a - b);
  const index = clamp(Math.ceil(sorted.length * p) - 1, 0, sorted.length - 1);
  return sorted[index];
}

/** 清理弹幕文本 */
function cleanText(text: string) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .replace(/^[\s，。！？!?~～…、,.。"'“”‘’()（）\[\]【】]+/, "")
    .replace(/[\s，。！？!?~～…、,.。"'“”‘’()（）\[\]【】]+$/, "")
    .trim();
}

/**
 * 提取高频弹幕词
 * 直播弹幕重复度很高，先统计完整文本，再补充文本中的高频片段
 */
function extractKeywords(texts: string[], topN: number): string[] {
  const fullFreq = new Map<string, number>();
  const gramFreq = new Map<string, number>();

  for (const raw of texts) {
    const text = cleanText(raw);
    if (!text) continue;

    if (text.length >= 2 && text.length <= 20) {
      fullFreq.set(text, (fullFreq.get(text) ?? 0) + 1);
    }

    // 长文本补充 2~6 字的片段，用于捕捉同一话题下的不同表述
    if (text.length > 6 && text.length <= 40) {
      const maxN = Math.min(6, text.length);
      for (let n = 2; n <= maxN; n++) {
        for (let i = 0; i + n <= text.length; i++) {
          const gram = text.slice(i, i + n);
          if (!/[\u4e00-\u9fa5A-Za-z0-9]/.test(gram)) continue;
          // 片段中不能夹杂标点，避免切出无意义内容
          if (n >= 2 && !/^[\u4e00-\u9fa5A-Za-z0-9]+$/.test(gram)) continue;
          gramFreq.set(gram, (gramFreq.get(gram) ?? 0) + 1);
        }
      }
    }
  }

  const candidates: { word: string; score: number }[] = [];
  for (const [word, count] of fullFreq) {
    if (STOP_WORDS.has(word)) continue;
    if (count < 2 && word.length < 3) continue;
    candidates.push({ word, score: count * (1 + word.length * 0.1) });
  }
  for (const [word, count] of gramFreq) {
    if (count < 3) continue;
    if (STOP_WORDS.has(word)) continue;
    candidates.push({ word, score: count * 0.4 * (1 + word.length * 0.1) });
  }

  candidates.sort((a, b) => b.score - a.score || b.word.length - a.word.length);

  const picked: string[] = [];
  for (const candidate of candidates) {
    if (picked.length >= topN) break;
    // 已经选择了更长的同类词就跳过
    if (picked.some((word) => word.includes(candidate.word) || candidate.word.includes(word))) {
      continue;
    }
    picked.push(candidate.word);
  }
  return picked;
}

/** 格式化付费事件描述 */
function formatPaidEvent(
  type: "sc" | "gift" | "guard",
  item: {
    text?: string;
    user?: string;
    gift_name?: string;
    gift_count?: number;
    gift_price?: number;
  },
) {
  const price = Number(item.gift_price);
  const count = Number(item.gift_count) || 1;
  if (type === "sc") {
    const priceText = Number.isFinite(price) && price > 0 ? `¥${price}` : "";
    return `SC${priceText ? ` ${priceText}` : ""}：${cleanText(item.text ?? "")}`.slice(0, 100);
  }
  if (type === "guard") {
    return `${item.user ?? "用户"} 开通了 ${item.gift_name ?? "大航海"}`;
  }
  return `${item.user ?? "用户"} 投喂 ${item.gift_name ?? "礼物"}x${count}${
    Number.isFinite(price) && price > 0 ? `（约${price * count}元）` : ""
  }`;
}

/**
 * 分析弹幕文件，产出密度序列、高能点和付费事件
 */
export async function analyzeDanmaku(
  file: string,
  options: DanmakuAnalysisOptions = {},
): Promise<DanmakuAnalysis> {
  const interval = Math.max(options.interval ?? 10, 1);
  const windowSize = Math.max(options.windowSize ?? 60, interval);
  const maxSpots = Math.max(options.maxSpots ?? 30, 1);
  const keywordsPerSpot = options.keywordsPerSpot ?? 8;
  const minSpotDistance = options.minSpotDistance ?? windowSize * 2;
  const maxKeywordSample = options.maxKeywordSample ?? 3000;

  const { danmu, sc, gift, guard } = await parseDanmu(file);

  const texts = danmu
    .filter((item) => Number.isFinite(Number(item.ts)) && Number(item.ts) >= 0)
    .map((item) => ({ time: Number(item.ts), text: String(item.text ?? "") }));

  const paidEvents: DanmakuPaidEvent[] = [];
  const pushEvent = (time: number, text: string, weight: number) => {
    if (!Number.isFinite(time) || time < 0) return;
    paidEvents.push({ time, text, weight });
  };

  for (const item of sc) {
    const price = Number(item.gift_price);
    pushEvent(
      Number(item.ts),
      formatPaidEvent("sc", item),
      Number.isFinite(price) ? clamp(30 + price / 10, 30, 200) : 30,
    );
  }
  for (const item of guard) {
    pushEvent(Number(item.ts), formatPaidEvent("guard", item), 120);
  }
  for (const item of gift) {
    const price = Number(item.gift_price);
    const count = Number(item.gift_count) || 1;
    const total = Number.isFinite(price) ? price * count : 0;
    // 过滤掉小礼物，避免事件列表被刷屏
    if (total < 5 && count < 10) continue;
    pushEvent(Number(item.ts), formatPaidEvent("gift", item), clamp(20 + total / 10, 20, 150));
  }

  let duration = 0;
  for (const item of texts) duration = Math.max(duration, item.time);
  for (const event of paidEvents) duration = Math.max(duration, event.time);

  if (texts.length === 0 && paidEvents.length === 0) {
    return { total: 0, paidCount: 0, duration: 0, density: [], spots: [], paidEvents: [] };
  }

  const bucketCount = Math.max(1, Math.ceil((duration + interval) / interval));
  const counts = new Array<number>(bucketCount).fill(0);
  const paidScores = new Array<number>(bucketCount).fill(0);

  const toBucket = (time: number) => clamp(Math.floor(time / interval), 0, bucketCount - 1);

  for (const item of texts) counts[toBucket(item.time)]++;
  for (const event of paidEvents) paidScores[toBucket(event.time)] += event.weight;

  texts.sort((a, b) => a.time - b.time);
  paidEvents.sort((a, b) => a.time - b.time);

  /** 第一个 time >= target 的下标 */
  const lowerBound = (items: { time: number }[], target: number) => {
    let low = 0;
    let high = items.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (items[mid].time < target) low = mid + 1;
      else high = mid;
    }
    return low;
  };
  const sliceByTime = <T extends { time: number }>(items: T[], start: number, end: number) =>
    items.slice(lowerBound(items, start), lowerBound(items, end));

  // 滑动窗口求和
  const prefix = new Array<number>(bucketCount + 1).fill(0);
  const paidPrefix = new Array<number>(bucketCount + 1).fill(0);
  for (let i = 0; i < bucketCount; i++) {
    prefix[i + 1] = prefix[i] + counts[i];
    paidPrefix[i + 1] = paidPrefix[i] + paidScores[i];
  }
  const halfWindow = Math.max(1, Math.round(windowSize / 2 / interval));
  const smoothed: number[] = [];
  const smoothedPaid: number[] = [];
  for (let i = 0; i < bucketCount; i++) {
    const start = Math.max(0, i - halfWindow);
    const end = Math.min(bucketCount, i + halfWindow + 1);
    smoothed.push(prefix[end] - prefix[start]);
    smoothedPaid.push(paidPrefix[end] - paidPrefix[start]);
  }

  // 峰值挑选：_score 高的优先，且互相之间保持最小间隔
  const threshold = Math.max(2, percentile(smoothed, 0.8));
  const order = smoothed
    .map((value, index) => ({ index, value }))
    .filter((item) => item.value >= threshold)
    .sort((a, b) => b.value - a.value);

  const picked: number[] = [];
  for (const item of order) {
    if (picked.length >= maxSpots) break;
    const time = item.index * interval;
    if (picked.some((index) => Math.abs(index * interval - time) < minSpotDistance)) continue;
    picked.push(item.index);
  }
  picked.sort((a, b) => a - b);

  const spots: DanmakuSpot[] = picked.map((index) => {
    // 在窗口内找到弹幕最密集的时刻作为峰值时间
    const windowStart = Math.max(0, index - halfWindow);
    const windowEnd = Math.min(bucketCount, index + halfWindow + 1);
    let peakIndex = index;
    const scoreOf = (i: number) => counts[i] + paidScores[i] / 50;
    for (let i = windowStart; i < windowEnd; i++) {
      if (scoreOf(i) > scoreOf(peakIndex)) peakIndex = i;
    }

    const time = peakIndex * interval;
    const start = Math.max(0, time - windowSize / 2);
    const end = time + windowSize / 2;
    const windowTexts = sliceByTime(texts, start, end)
      .slice(0, maxKeywordSample)
      .map((item) => item.text);
    const events = sliceByTime(paidEvents, start, end)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 5)
      .map((item) => item.text);
    return {
      time,
      count: smoothed[peakIndex],
      score: smoothed[peakIndex] + smoothedPaid[peakIndex],
      keywords: extractKeywords(windowTexts, keywordsPerSpot),
      events,
    };
  });

  logger.info("弹幕分析完成", {
    file,
    total: texts.length,
    paidCount: paidEvents.length,
    duration,
    spots: spots.length,
  });

  return {
    total: texts.length,
    paidCount: paidEvents.length,
    duration,
    density: counts.map((count, index) => ({ time: index * interval, count })),
    spots,
    paidEvents: paidEvents.slice(0, 200),
  };
}

/** 生成给 LLM 的弹幕高能点文本 */
export function formatDanmakuForPrompt(
  analysis: DanmakuAnalysis,
  options?: { maxEvents?: number },
) {
  const maxEvents = options?.maxEvents ?? 60;
  const spotLines = analysis.spots.map((spot) => {
    const parts = [`${formatTimestamp(spot.time)} 弹幕${spot.count}条`];
    if (spot.keywords.length > 0) parts.push(`热点词: ${spot.keywords.join("、")}`);
    if (spot.events.length > 0) parts.push(`事件: ${spot.events.join("；")}`);
    return parts.join(" | ");
  });

  const eventLines = analysis.paidEvents
    .slice(0, maxEvents)
    .map((event) => `${formatTimestamp(event.time)} ${event.text}`);

  const sections = [
    `弹幕总数：${analysis.total}，付费互动：${analysis.paidCount}`,
    spotLines.length > 0 ? `弹幕高能点（按时间）：\n${spotLines.join("\n")}` : "",
    eventLines.length > 0 ? `重要付费事件：\n${eventLines.join("\n")}` : "",
  ].filter(Boolean);

  return sections.join("\n\n");
}

/** 秒 -> hh:mm:ss */
export function formatTimestamp(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}
