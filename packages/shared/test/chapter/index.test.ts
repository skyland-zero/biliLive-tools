import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { StandardASRResult } from "../../src/ai/asr/types.js";

const state = vi.hoisted(() => ({
  llmCalls: [] as { system: string; user: string }[],
  danmaku: [] as {
    danmu: { ts: number; text: string }[];
    sc: any[];
    gift: any[];
    guard: any[];
  },
  singingSegments: [] as {
    startTime: number;
    endTime: number;
    duration: number;
    confidence: number;
  }[],
  chapters: [
    { time: "00:00:00", title: "开场聊天" },
    { time: "00:10:00", title: "这是一个特别特别长的标题需要被截断处理" },
  ],
}));

const config = {
  ai: {
    vendors: [{ id: "vendor-1", provider: "aliyun", name: "test", apiKey: "key" }],
    models: [
      { modelId: "asr-1", vendorId: "vendor-1", modelName: "fun-asr", tags: ["asr"], config: {} },
      {
        modelId: "llm-1",
        vendorId: "vendor-1",
        modelName: "qwen-plus",
        tags: ["llm"],
        config: {},
      },
    ],
    chapterRecognize: {
      asrModelId: "asr-1",
      llmModelId: "llm-1",
      prompt: "章节提示词",
      maxChapters: 10,
      minChapterInterval: 60,
      maxTitleLength: 16,
      timelineWithHighlight: true,
    },
  },
};

vi.mock("../../src/config.js", () => ({
  appConfig: {
    getAll: () => config,
    get: () => undefined,
  },
}));

vi.mock("../../src/task/video.js", () => ({
  addExtractAudioTask: vi.fn(async (_input: string, outputFilePath: string) => {
    const task = {
      output: path.join(os.tmpdir(), "biliLive-tools", outputFilePath),
      handlers: {} as Record<string, (payload: any) => void>,
      on(event: string, handler: (payload: any) => void) {
        this.handlers[event] = handler;
        setTimeout(() => handler({}), 0);
        return this;
      },
    };
    return task;
  }),
}));

vi.mock("../../src/ai/asr/adapter.js", () => ({
  recognize: vi.fn(async (): Promise<StandardASRResult> => {
    return globalThis.__chapterTestASR!;
  }),
}));

vi.mock("../../src/musicDetector/index.js", () => ({
  musicDetect: vi.fn(async () => state.singingSegments),
}));

vi.mock("../../src/ai/llm/qwen.js", () => ({
  QwenLLM: class {
    async sendMessage(user: string, system: string) {
      state.llmCalls.push({ system, user });
      // 唱歌复核
      if (system.includes("内容审核员")) {
        return {
          content: JSON.stringify({
            segments: [{ index: 0, isSinging: true, confidence: 0.9, name: "测试歌曲" }],
          }),
          finishReason: "stop",
        };
      }
      // 分块阶段的话题提示词
      if (system.includes("话题切分")) {
        return {
          content: JSON.stringify({ topics: [{ time: "00:00:00", topic: "本段话题" }] }),
          finishReason: "stop",
        };
      }
      return {
        content: JSON.stringify({ chapters: state.chapters }),
        finishReason: "stop",
      };
    }
  },
}));

vi.mock("../../src/danmu/index.js", () => ({
  parseDanmu: vi.fn(async () => ({
    danmu: state.danmaku.flatMap((item) => item.danmu),
    sc: state.danmaku.flatMap((item) => item.sc),
    gift: state.danmaku.flatMap((item) => item.gift),
    guard: state.danmaku.flatMap((item) => item.guard),
    metadata: {},
  })),
}));

declare global {
  // eslint-disable-next-line no-var
  var __chapterTestASR: StandardASRResult | undefined;
}

const {
  analyzeDanmaku,
  buildTimelineEvents,
  collectAsrCandidates,
  generateChapters,
  parseTimeToSeconds,
  buildTranscriptLines,
  renderTimelineText,
} = await import("../../src/chapter/index.js");

const workDir = path.join(os.tmpdir(), `biliLive-tools-chapter-test-${process.pid}`);

async function createFile(name: string, content = "test") {
  const filePath = path.join(workDir, name);
  await fs.ensureDir(workDir);
  await fs.writeFile(filePath, content);
  return filePath;
}

beforeEach(async () => {
  state.llmCalls = [];
  state.danmaku = [];
  state.singingSegments = [];
  state.chapters = [
    { time: "00:00:00", title: "开场聊天" },
    { time: "00:10:00", title: "这是一个特别特别长的标题需要被截断处理" },
  ];
  globalThis.__chapterTestASR = undefined;
});

afterAll(async () => {
  await fs.remove(workDir);
});

describe("parseTimeToSeconds", () => {
  it("支持多种时间格式", () => {
    expect(parseTimeToSeconds("01:30")).toBe(90);
    expect(parseTimeToSeconds("01:01:30")).toBe(3690);
    expect(parseTimeToSeconds(120)).toBe(120);
    expect(parseTimeToSeconds("120")).toBe(120);
    expect(parseTimeToSeconds("abc")).toBe(-1);
  });
});

describe("buildTranscriptLines", () => {
  it("按间隔与长度合并句子", () => {
    const lines = buildTranscriptLines(
      [
        { id: 0, start: 0, end: 5, text: "大家好这里是测试" },
        { id: 1, start: 5, end: 10, text: "今天聊点别的" },
        { id: 2, start: 60, end: 65, text: "换话题了" },
      ],
      { maxLineChars: 50, minLineChars: 4, gapSeconds: 3 },
    );
    expect(lines).toHaveLength(2);
    expect(lines[0].text).toBe("大家好这里是测试今天聊点别的");
    expect(lines[1].start).toBe(60);
  });
});

describe("analyzeDanmaku", () => {
  it("计算密度、高能点、关键词和付费事件", async () => {
    const danmu = [];
    for (let i = 0; i < 30; i++) danmu.push({ ts: 100 + i * 0.5, text: "笑死我了" });
    for (let i = 0; i < 5; i++) danmu.push({ ts: 1000 + i, text: `第${i}条普通弹幕` });

    state.danmaku = [
      {
        danmu,
        sc: [{ ts: 101, text: "好活", gift_price: 30 }],
        guard: [{ ts: 1000, user: "老板", gift_name: "舰长" }],
        gift: [{ ts: 1001, user: "观众", gift_name: "小心心", gift_count: 20, gift_price: 1 }],
      },
    ];

    const result = await analyzeDanmaku("test.xml", { interval: 10, windowSize: 60 });

    expect(result.total).toBe(35);
    expect(result.duration).toBe(1004);
    expect(result.density.length).toBeGreaterThan(0);
    expect(result.spots.length).toBeGreaterThan(0);

    const hotSpot = result.spots.reduce((best, spot) => (spot.count > best.count ? spot : best));
    expect(hotSpot.time).toBeGreaterThanOrEqual(100);
    expect(hotSpot.time).toBeLessThanOrEqual(140);
    expect(hotSpot.count).toBeGreaterThanOrEqual(30);
    expect(hotSpot.keywords).toContain("笑死我了");
    expect(hotSpot.events.some((event) => event.includes("好活"))).toBe(true);

    expect(result.paidEvents.some((event) => event.text.includes("开通了 舰长"))).toBe(true);
    expect(result.paidEvents.some((event) => event.text.includes("长心"))).toBe(false);
  });
});

describe("detectSinging", () => {
  it("从 ASR 的 music 分数收集候选片段", () => {
    const candidates = collectAsrCandidates(
      {
        text: "",
        segments: [
          { id: 0, start: 0, end: 10, text: "说话", music: 0.1 },
          { id: 1, start: 10, end: 40, text: "歌词一", music: 0.8 },
          { id: 2, start: 45, end: 90, text: "歌词二", music: 0.9 },
          { id: 3, start: 200, end: 210, text: "说话", music: 0.2 },
        ],
      },
      { minDuration: 20, musicThreshold: 0.5, maxGap: 10 },
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].start).toBe(10);
    expect(candidates[0].end).toBe(90);
    expect(candidates[0].sources).toEqual(["asr"]);
  });

  it("唱歌片段进入章节与时间轴", async () => {
    globalThis.__chapterTestASR = {
      text: "唱歌",
      duration: 1200,
      segments: [
        { id: 0, start: 0, end: 20, text: "大家好，欢迎来到今天的直播" },
        { id: 1, start: 300, end: 500, text: "啦啦啦啦啦", music: 0.95 },
      ],
    };
    // 音频特征信号
    state.singingSegments = [{ startTime: 300, endTime: 500, duration: 200, confidence: 0.8 }];
    // LLM 把唱歌作为章节
    state.chapters = [
      { time: "00:00:00", title: "开场聊天" },
      { time: "00:05:00", title: "唱歌：测试歌曲" },
    ];

    const videoFile = await createFile("singing.mp4", "singing-video-content");
    const result = await generateChapters({
      videoFile,
      recognizeMusicName: true,
      minChapterInterval: 60,
    });

    expect(result.singing).toHaveLength(1);
    expect(result.singing[0].sources).toContain("audio");
    expect(result.singing[0].sources).toContain("llm");

    const singingChapter = result.chapters[1];
    expect(singingChapter.start).toBe(300);
    expect(singingChapter.musicName).toBe("测试歌曲");

    // 唱歌起点与章节起点重合时被章节吸收，不重复出条目
    const singingTopic = result.events.find(
      (event) => event.type === "topic" && event.start === 300,
    );
    expect(singingTopic?.musicName).toBe("测试歌曲");
    expect(result.timelineText).toContain("🎤");
    expect(result.chapterText).toContain("唱歌：测试歌曲");
  });
});

describe("buildTimelineEvents", () => {
  const chapters = [
    { start: 0, end: 600, title: "开场", highlight: false },
    { start: 600, end: 1200, title: "游戏", highlight: true },
  ];

  it("章节吸收过近的高能与唱歌点", () => {
    const events = buildTimelineEvents({
      chapters,
      danmaku: {
        total: 100,
        paidCount: 0,
        duration: 1200,
        density: [],
        paidEvents: [],
        spots: [
          { time: 605, count: 300, score: 300, keywords: ["哈哈"], events: [] },
          { time: 900, count: 200, score: 200, keywords: ["好看"], events: [] },
        ],
      },
      singing: [
        { start: 610, end: 800, confidence: 0.9, sources: ["audio"] },
        { start: 1000, end: 1100, confidence: 0.7, sources: ["asr"], name: "某歌" },
      ],
    });

    const topics = events.filter((event) => event.type === "topic");
    expect(topics).toHaveLength(2);
    // 605 与章节起点 600 过近被吸收，900 保留
    const highlights = events.filter((event) => event.type === "highlight");
    expect(highlights).toHaveLength(1);
    expect(highlights[0].start).toBe(900);
    // 610 被吸收，1000 保留
    const singings = events.filter((event) => event.type === "singing");
    expect(singings).toHaveLength(1);
    expect(singings[0].start).toBe(1000);
    expect(singings[0].musicName).toBe("某歌");
  });

  it("时间轴受预算约束时优先保留唱歌与高能", () => {
    const events = buildTimelineEvents({
      chapters,
      danmaku: {
        total: 100,
        paidCount: 0,
        duration: 1200,
        density: [],
        paidEvents: [],
        spots: [
          { time: 300, count: 100, score: 100, keywords: ["一般"], events: [] },
          { time: 900, count: 500, score: 500, keywords: ["爆炸"], events: [] },
        ],
      },
      singing: [{ start: 1000, end: 1100, confidence: 0.95, sources: ["audio"] }],
    });

    const text = renderTimelineText(events, { duration: 1200, maxItems: 4 });
    expect(text).toContain("爆炸");
    expect(text).toContain("🎤");

    const limited = renderTimelineText(events, { duration: 1200, maxItems: 2 });
    // 主干章节优先，点事件全部裁掉
    expect(limited.split("\n")).toHaveLength(3);
  });
});

describe("generateChapters", () => {
  it("短文本走单次汇总，并生成章节与时间轴", async () => {
    globalThis.__chapterTestASR = {
      text: "大家好",
      duration: 1200,
      segments: [
        { id: 0, start: 0, end: 20, text: "大家好，欢迎来到今天的直播" },
        { id: 1, start: 600, end: 620, text: "接下来我们聊第二个话题" },
      ],
    };

    const videoFile = await createFile("short.mp4");
    const danmuFile = await createFile("short.xml", "<i></i>");
    state.danmaku = [
      {
        danmu: Array.from({ length: 50 }, (_, i) => ({ ts: 600 + i * 0.2, text: "名场面" })),
        sc: [],
        gift: [],
        guard: [],
      },
    ];

    const result = await generateChapters({ videoFile, danmuFile });

    // 单块时只有一次汇总调用
    expect(state.llmCalls).toHaveLength(1);
    // 首章强制 00:00
    expect(result.chapters[0].start).toBe(0);
    // 标题被截断到 16 字
    expect(result.chapters[1].title.length).toBeLessThanOrEqual(16);
    // 时间轴包含高能标记
    expect(result.chapterText.split("\n")).toHaveLength(2);
    expect(result.chapterText.startsWith("00:00 开场聊天")).toBe(true);
    expect(result.timelineText.startsWith("📌 时间轴")).toBe(true);
    expect(result.timelineText).toContain("🔥");
    expect(result.danmaku?.spots.length).toBeGreaterThan(0);
  });

  it("长文本分块分析后再汇总", async () => {
    globalThis.__chapterTestASR = {
      text: "长文本",
      duration: 6000,
      segments: Array.from({ length: 400 }, (_, i) => ({
        id: i,
        start: i * 15,
        end: i * 15 + 12,
        text: `这是第${i}段转写内容，用来测试长视频的分块逻辑是否正常工作。`,
      })),
    };

    const videoFile = await createFile("long.mp4", "a-different-video-content");
    const result = await generateChapters({ videoFile });

    // 分块调用 + 一次汇总
    expect(state.llmCalls.length).toBeGreaterThan(2);
    expect(state.llmCalls[0].system).toContain("话题切分");
    expect(state.llmCalls[state.llmCalls.length - 1].system).toBe("章节提示词");
    // 超过 2 小时使用 hh:mm:ss
    expect(result.chapterText.startsWith("00:00:00 开场聊天")).toBe(true);
  });
});
