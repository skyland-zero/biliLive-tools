# 介绍

## 初始化

设置默认添加了千问的供应商，你仅需要配置key即可开始使用，首先查看[官方文档](https://help.aliyun.com/zh/model-studio/first-api-call-to-qwen)进行注册，拿到key后在“设置->AI配置->供应商”阿里云中并配置相关的key，由于我主要使用qwen进行开发，其他模型的兼容性未经过测试，如果有更多模型的支持，欢迎PR

软件还内置了 **Command Code** 供应商（OpenAI 兼容接口，Base URL 已预填），在 [commandcode.ai](https://commandcode.ai) 创建 API Key 后在“设置->AI配置->供应商->Command Code”中填上即可。默认已带一个模型 `deepseek/deepseek-v4.1-flash`（1M 上下文），章节生成默认使用它；需要其他模型时可以对照 [模型列表](https://api.commandcode.ai/provider/v1/models) 在“模型”页自己添加，模型名要填完整的 ID（如 `z-ai/glm-5.3-flash`）。GOAT 及以上计划才有 API 权限，Go 计划调用会返回 403。

接下来会介绍相关的一些功能。

## 歌切

位于切片右键选项中，为了此功能而引入的AI，目标是更快更好得识别音乐名称以及生成歌词

#### 流程图

```mermaid
flowchart TD
    Start([开始: songRecognize]) --> GetConfig[获取配置参数]
    GetConfig --> Shazam[Shazam 识别]

    Shazam -->|否| ExtractSegments[提取4个采样片段<br/>0秒/10秒/中段/尾段]

    ExtractSegments --> ApplyFilter[应用人声增强滤镜]
    ApplyFilter --> ProgressiveRecognize[渐进式识别]
    ProgressiveRecognize --> RecognizeLoop{当前片段识别成功?}
    RecognizeLoop -->|是| QueryInfo[查询详细信息]
    RecognizeLoop -->|否, 还有片段| ProgressiveRecognize
    RecognizeLoop -->|否, 全部失败| NoShazamResult[Shazam 未识别到]

    QueryInfo --> CheckLyricNeeded{歌词优化?}
    CheckLyricNeeded -->|是| QueryLyrics[查询歌词]
    CheckLyricNeeded -->|否| ShazamDone[Shazam 查询完成]
    QueryLyrics --> ShazamDone

    ShazamDone --> CheckOptimize{需要歌词优化?}
    NoShazamResult --> CheckOptimize

    CheckOptimize -->|否 且有歌曲名| ReturnName[直接返回歌曲名称]
    CheckOptimize -->|是| ASR[ASR 音频识别]

    ASR --> CheckASRText{识别到文本?}
    CheckASRText -->|否| End1([结束: 无法识别])
    CheckASRText -->|是| CheckShazamResult{Shazam 有结果?}

    CheckShazamResult -->|否| LLM[LLM 识别歌曲信息]
    CheckShazamResult -->|是| CheckLyrics{歌词优化?}

    LLM --> LLMResult{LLM 识别成功?}
    LLMResult -->|否| End2([结束: 未识别到])
    LLMResult -->|是| CheckLyrics

    CheckLyrics -->|是| OptimizeLyrics[LLM 优化歌词]
    CheckLyrics -->|否| NoLyrics[使用ASR歌词]

    OptimizeLyrics --> ReturnResult[返回结果<br/>name + lyrics]
    NoLyrics --> ReturnResult
    ReturnName --> End3([结束])
    ReturnResult --> End3
    End1 --> End3
    End2 --> End3

    style Start fill:#e1f5e1
    style End3 fill:#ffe1e1
    style Shazam fill:#e3f2fd
    style ASR fill:#e3f2fd
    style LLM fill:#e3f2fd
    style OptimizeLyrics fill:#fff3e0
    style ReturnResult fill:#f3e5f5
```

## 字幕识别 && 歌词识别

位于切片右键选项中，目标就是为切片生成字幕了，逻辑也十分简单，将片段音频喂给asr引擎，拿到词级时间戳进行排版

### 字幕识别 && 歌词识别 有何区别

在某些接口中，字幕识别会主动过滤掉音乐片段，歌词识别则不会

### ffmpeg 的 Whisper 支持

由于 ffmpeg8.0 支持了[whispercpp](https://github.com/ggml-org/whisper.cpp)，但是本软件支持的只是7.1，由于8.0要求的cuda版本较高可能造成大量n卡硬件编码错误，所有软件本体的ffmpeg版本暂时不会更新。

但我仍然为想要使用的用户提供了渠道，只是需要一些额外的配置。

第一步的相关你也可以直接在[夸克网盘](https://pan.quark.cn/s/6da253a1ecb8)下载。

不推荐在歌词识别中使用~~当然你也识别不出什么~~，如果出现什么不能使用gpu加速也别来问我，我也不知道

#### 配置步骤

1. **下载 ffmpeg 8.0 和 Whisper 模型**
   - 下载 ffmpeg 8.0 版本（或从[夸克网盘](https://pan.quark.cn/s/6da253a1ecb8)获取）
   - 下载 Whisper 模型文件（[huggingface.co/ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp)）
   - **推荐使用大参数模型**（如 `ggml-large-v3.bin`）以获得更好的识别效果
   - **后两步的路径中如包含空格或一些奇怪字符，可能会导致无法使用**

2. **配置供应商**
   - 打开：设置 -> AI配置 -> 供应商
   - 点击"添加供应商"
   - **供应商类型**：选择 `ffmpeg`
   - **配置名称**：自定义名称（如 "FFmpeg Whisper"）
   - **API Key**：随意填写（不会被使用）
   - **Base URL**：填写 ffmpeg 可执行文件的**完整路径**（如 `C:\ffmpeg\ffmpeg.exe`）

3. **添加模型配置**
   - 切换到"模型"选项卡
   - 点击"添加模型"
   - **供应商**：选择刚才创建的 ffmpeg 供应商
   - **模型名称**：填写 Whisper 模型文件的**完整路径**（如 `C:\models\ggml-large-v3.bin`）
   - **标签**：勾选 `ASR`
   - **备注**：可选，填写说明（如 "本地 Whisper 大模型"）

## 章节生成

位置：工具 - 章节生成。

输入一段**完整的录像文件**和对应的**弹幕 XML 文件**，自动分析并生成：

- **B站章节目录**：投稿页「分段章节」直接使用的时间 + 标题列表
- **置顶评论时间轴**：发布后置顶评论即可，时间戳可直接跳转，包含话题章节、🔥弹幕高能、🎤唱歌三类条目
- **唱歌片段列表**：时间、时长、置信度、判定依据，可选推测歌名

生成结果只作为文本输出，不会自动写入 B 站，需要你手动粘贴。

#### 流程图

```mermaid
flowchart TD
    Start([开始: 章节生成]) --> Check{命中 ASR 缓存?}
    Check -->|是| Lines
    Check -->|否| Extract[提取音频<br/>16k 单声道 mp3]
    Extract --> ASR[ASR 语音识别<br/>句子级时间戳 + music 分数]
    ASR --> Lines[合并为带时间戳的文本行]

    Lines --> Singing[唱歌检测<br/>音频特征 + ASR music + 弹幕 + 模型复核]
    Lines --> Danmaku[解析弹幕 XML<br/>密度峰值 / 高频词 / 付费事件]
    Singing --> Candidate[统一候选信号<br/>话题 + 高能 + 唱歌]
    Danmaku --> Candidate

    Candidate --> Single{转写文本长度}
    Single -->|短| Merge
    Single -->|长| Chunk[分块分析<br/>每块提取候选话题]
    Chunk --> Merge[LLM 汇总<br/>结合高能与唱歌整理章节]
    Merge --> Post[后处理<br/>首章 00:00 / 吸附唱歌起点 / 限长]
    Post --> Timeline[统一事件流<br/>话题 + 🔥高能 + 🎤唱歌]
    Timeline --> Out1[B站章节文本]
    Timeline --> Out2[置顶评论时间轴]
    Timeline --> Out3[唱歌片段列表]

    style Start fill:#e1f5e1
    style Out1 fill:#f3e5f5
    style Out2 fill:#f3e5f5
    style Out3 fill:#f3e5f5
    style Danmaku fill:#e3f2fd
    style Singing fill:#e3f2fd
    style ASR fill:#e3f2fd
    style Merge fill:#fff3e0
```

### 时间轴是怎么拼出来的

时间轴是最终产物，它把三路信号合成一条统一的事件流：

| 信号             | 来源                                        | 在时间轴上的样子                  |
| ---------------- | ------------------------------------------- | --------------------------------- |
| 话题章节（主干） | 语音识别文本 + 唱歌/弹幕提示，交给 LLM 分段 | `12:30 嘉宾连麦`，必选条目        |
| 弹幕高能         | 弹幕密度峰值 + 高频词 + 付费互动            | `12:34 🔥 名场面（弹幕320条）`    |
| 唱歌片段         | 音频特征 + ASR music 分数 + 弹幕 + LLM 复核 | `20:15 🎤 唱歌《歌名》（4 分钟）` |

规则：

- 高能点/唱歌起点与某个章节起点相差 30 秒以内时，被章节吸收，不再重复展示
- 主干章节必选，🔥/🎤 条目按重要性补入，受「时间轴条数上限」与「时间轴字数上限」约束（默认 60 条 / 900 字，B站评论约 1000 字上限）
- 唱歌起点是很硬的边界信号，章节边界会优先吸附到它（±20 秒）

### 唱歌是怎么认出来的

四路信号融合，只用一路都不够稳：

| 信号           | 说明                                                                                                     | 适用范围                         |
| -------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 音频特征       | [music-segment-detector](https://www.npmjs.com/package/music-segment-detector) 逐帧分析 MFCC/能量/谱质心 | 本地计算、不花钱，有伴奏的演唱   |
| ASR music 分数 | 必剪 ASR 会对每句给出「是音乐的可能性」0~1                                                               | 免费且准，仅必剪 ASR 提供        |
| 弹幕关键词     | 「好听/歌名/awsl」等密度                                                                                 | 兜底佐证                         |
| 模型复核       | 把候选片段的转写文本给大模型判定是否在唱（可选顺便猜歌名）                                               | 清唱、跟唱这类音频特征易漏的场景 |

候选片段会按最小间隔合并，默认片长不少于 20 秒、间隔 15 秒内合并。

#### 唱歌识别的开销

- 音频特征分析会把音频抽成 WAV 再逐帧计算，**8 小时录像大概需要几分钟到十几分钟 CPU**（可在设置里关闭「检测唱歌片段」跳过）
- 音频特征结果按文件缓存，与切片工具里的「波形分析」**共用同一份缓存**，已经跑过波形分析的文件会直接命中
- 模型复核会把所有候选片段的转写文本**合并成一次调用**，额外开销很小；开启「推测歌名」不会增加调用次数，但不准的歌名会直接出现在时间轴上
- 音频分析失败（例如 ffmpeg 路径不对）不会中断流程，会退回只用 ASR 信号判断

### 配置

设置 - AI配置 - 功能 - 章节生成：

- **ASR模型**：为空时使用「字幕识别」中的模型
- **LLM模型**：用于整理章节的大模型，为空时使用模型列表中的第一个 LLM 模型
- **提示词**：最终汇总章节时使用的系统提示词
- **章节数量上限 / 章节最小间隔 / 标题字数上限**：默认 20 / 60秒 / 16字
- **单次文本上限**：默认 6000 字，超过就分块分析；模型上下文大的可以调大，避免分块后再汇总丢失细节
- **时间轴含高能点**：是否在时间轴中补入 🔥高能 与 🎤唱歌 条目
- **时间轴条数上限 / 字数上限**：默认 60 条 / 900 字
- **检测唱歌片段 / 推测歌名**：默认开启检测、关闭推测歌名

### 注意事项

- 分析长视频时语音识别与音频分析耗时较长，任务会进入任务队列，可在任务队列中查看进度
- 同一文件、同一 ASR 模型会复用缓存（与字幕识别共用），重复生成不会重复识别；但唱歌检测每次都会重跑
- 当前不支持中断语音识别，中断只会阻止后续步骤

## 常见问题

### 是否支持小米 MiMO ASR 2.5

该模型不支持时间戳，因此不会被支持
