# AI API

本页接口用于调用软件内置的 AI 能力，需要先在软件中配置好对应的模型。通用鉴权方式见 [基础 API](./base.md)。

## 生成章节与时间轴

分析完整的录像文件和弹幕文件，生成 B站章节目录、置顶评论时间轴与唱歌片段列表。

**接口地址：** `POST /ai/chapter`

该接口是**异步任务**，创建成功后返回 `taskId`，需要通过 [任务 API](./task.md#查询任务) 轮询任务状态，任务类型为 `chapter`。

| 参数                  | 类型    | 必填 | 说明                                                   |
| --------------------- | ------- | ---- | ------------------------------------------------------ |
| videoFile             | string  | 是   | 完整视频文件路径                                       |
| danmuFile             | string  | 否   | 弹幕 XML 文件路径，不传则仅根据语音内容生成            |
| asrModelId            | string  | 否   | 覆盖配置中的 ASR 模型 ID                               |
| llmModelId            | string  | 否   | 覆盖配置中的 LLM 模型 ID（支持任何 OpenAI 兼容服务）   |
| maxChapters           | number  | 否   | 章节数量上限，默认取配置值（20）                       |
| minChapterInterval    | number  | 否   | 相邻章节最小间隔（秒），默认取配置值（60）             |
| maxTitleLength        | number  | 否   | 章节标题最大字数，默认取配置值（16）                   |
| maxChunkChars         | number  | 否   | 单次 LLM 调用的文本上限（字符），默认取配置值（6000）  |
| timelineWithHighlight | boolean | 否   | 置顶评论时间轴是否包含弹幕高能点，默认取配置值（true） |
| detectSinging         | boolean | 否   | 是否检测唱歌片段，默认取配置值（true）                 |
| recognizeMusicName    | boolean | 否   | 是否让 LLM 推测歌名，默认取配置值（false）             |
| timelineMaxItems      | number  | 否   | 时间轴条目上限，默认取配置值（60）                     |
| timelineMaxChars      | number  | 否   | 时间轴字数上限，默认取配置值（900）                    |

**请求示例：**

```json
{
  "videoFile": "D:/records/live-2026-07-20.mp4",
  "danmuFile": "D:/records/live-2026-07-20.xml",
  "maxChapters": 20,
  "minChapterInterval": 60
}
```

**响应示例：**

```json
{
  "taskId": "task_123"
}
```

缺少 `videoFile` 时返回 HTTP 400。

**任务结果示例：**

任务完成后，`GET /task/:id` 的 `extra` 字段中包含生成结果：

```json
{
  "status": "completed",
  "progress": 100,
  "extra": {
    "chapters": [
      { "start": 0, "end": 630, "title": "开场聊天", "highlight": false },
      { "start": 630, "end": 1820, "title": "嘉宾连麦", "highlight": true },
      {
        "start": 1820,
        "end": 2400,
        "title": "唱歌：某首歌",
        "highlight": false,
        "musicName": "某首歌"
      }
    ],
    "singing": [
      {
        "start": 1820,
        "end": 2100,
        "confidence": 0.86,
        "name": "某首歌",
        "sources": ["audio", "asr", "llm"]
      }
    ],
    "events": [
      { "type": "topic", "start": 0, "end": 630, "title": "开场聊天", "score": 1 },
      {
        "type": "topic",
        "start": 630,
        "end": 1820,
        "title": "嘉宾连麦",
        "score": 1,
        "highlight": true
      },
      { "type": "highlight", "start": 900, "title": "名场面", "score": 0.8, "detail": "弹幕320条" },
      {
        "type": "singing",
        "start": 1820,
        "end": 2100,
        "title": "唱歌：某首歌",
        "score": 1,
        "musicName": "某首歌"
      }
    ],
    "chapterText": "00:00 开场聊天\n10:30 嘉宾连麦\n30:20 唱歌：某首歌",
    "timelineText": "📌 时间轴\n00:00 开场聊天\n10:30 嘉宾连麦 🔥\n15:00 🔥 名场面（弹幕320条）\n30:20 唱歌：某首歌 🎤",
    "duration": 1820,
    "danmaku": {
      "total": 12345,
      "paidCount": 12,
      "duration": 1820,
      "spots": [{ "time": 640, "count": 320, "score": 420, "keywords": ["哈哈"], "events": [] }]
    }
  }
}
```

`chapterText` 可直接粘贴到投稿页的「分段章节」，`timelineText` 可直接作为置顶评论。结果只做生成，不会写入 B 站。

`events` 是统一事件流（`topic` 话题 / `highlight` 弹幕高能 / `singing` 唱歌），时间轴就是从它渲染出来的；`singing` 是唱歌片段列表，`sources` 表示判定依据（`audio` 音频特征、`asr` 语音识别的 music 分数、`danmaku` 弹幕关键词、`llm` 模型复核）。

## 常见错误

| HTTP 状态 | 可能原因                               |
| --------- | -------------------------------------- |
| 400       | 缺少 `videoFile`                       |
| 401 / 403 | 未提供或提供了错误的接口 PassKey       |
| 5xx       | 模型未配置、文件不存在或任务初始化失败 |
