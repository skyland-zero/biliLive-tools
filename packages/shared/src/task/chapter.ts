import path from "node:path";

import { AbstractTask, taskQueue } from "./core/index.js";
import { generateChapters } from "../chapter/index.js";
import { TaskType } from "../enum.js";
import logger from "../utils/log.js";

import type { ChapterResult, GenerateChaptersOptions } from "../chapter/index.js";

/** 章节生成任务，结果保存在 extra 中 */
export class ChapterTask extends AbstractTask {
  type = TaskType.chapter;
  options: GenerateChaptersOptions;
  canceled = false;

  constructor(options: GenerateChaptersOptions) {
    super();
    this.options = options;
    this.name = `章节生成: ${path.parse(options.videoFile).base}`;
    this.action = ["kill"];
    this.progress = 0;
  }

  exec() {
    this.status = "running";
    this.startTime = Date.now();
    this.progress = 0;
    this.emitter.emit("task-start", { taskId: this.taskId });

    generateChapters({
      ...this.options,
      isCanceled: () => this.canceled,
      onProgress: (data) => {
        this.progress = data.percentage;
        this.custsomProgressMsg = data.message;
        this.emitter.emit("task-progress", { taskId: this.taskId });
      },
    })
      .then((result) => {
        if (this.canceled) {
          this.status = "canceled";
          return;
        }
        this.status = "completed";
        this.progress = 100;
        this.custsomProgressMsg = "章节生成完成";
        this.extra = this.stringifyResult(result);
        this.emitter.emit("task-end", { taskId: this.taskId });
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        if (this.canceled) {
          this.status = "canceled";
          return;
        }
        this.status = "error";
        this.error = message;
        logger.error("章节生成失败", err);
        this.emitter.emit("task-error", { taskId: this.taskId, error: message });
      })
      .finally(() => {
        this.endTime = Date.now();
      });
  }

  /** 只保留渲染需要的数据，避免任务列表过大 */
  private stringifyResult(result: ChapterResult) {
    return {
      chapters: result.chapters,
      chapterText: result.chapterText,
      timelineText: result.timelineText,
      duration: result.duration,
      danmaku: result.danmaku
        ? {
            total: result.danmaku.total,
            paidCount: result.danmaku.paidCount,
            duration: result.danmaku.duration,
            spots: result.danmaku.spots,
          }
        : null,
    };
  }

  pause() {
    return false;
  }

  resume() {
    return false;
  }

  kill() {
    if (this.status === "completed" || this.status === "error" || this.status === "canceled") {
      return;
    }
    logger.warn(`chapter task ${this.taskId} killed`);
    this.canceled = true;
    this.status = "canceled";
    return true;
  }
}

/** 添加章节生成任务 */
export function addChapterTask(options: GenerateChaptersOptions) {
  const task = new ChapterTask(options);
  taskQueue.addTask(task, false);
  return task;
}
