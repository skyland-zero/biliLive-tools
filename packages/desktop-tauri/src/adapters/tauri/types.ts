/**
 * Tauri 桌面端 window.api 契约。
 *
 * 与 packages/app/src/preload/index.ts 暴露的 api 保持一致，
 * renderer 只依赖这份契约，实现由本目录的 adapters 提供。
 */
import type { AppConfig, FfmpegOptions, Theme } from "@biliLive-tools/types";

export interface DialogFilter {
  name: string;
  extensions: string[];
}

export interface OpenDialogOptions {
  title?: string;
  defaultPath?: string;
  buttonLabel?: string;
  filters?: DialogFilter[];
  /** 是否多选 */
  multi?: boolean;
}

export interface OpenDirectoryOptions {
  defaultPath?: string;
  buttonLabel?: string;
  title?: string;
}

export interface SaveDialogOptions {
  title?: string;
  defaultPath?: string;
  filters?: DialogFilter[];
}

export interface SubWindowOptions {
  routeName: string;
  hideAside?: boolean;
  hideMenuBar?: boolean;
  maximized?: boolean;
  query?: Record<string, string>;
}

export interface NotifyData {
  type: "info" | "success" | "warning" | "error";
  content: string;
}

export interface WindowApi {
  dbQuery: (options: any) => Promise<any>;
  dbList: (options: any) => Promise<any>;
  addWithStreamer: (options: any) => Promise<any>;
  cookie: {
    baiduLogin: () => Promise<string>;
    xhsLogin: () => Promise<string>;
    douyinLogin: () => Promise<string>;
  };
  common: {
    readFile: (path: string) => Promise<string>;
    writeFile: (path: string, data: string) => Promise<void>;
    mkdir: (path: string) => Promise<void>;
    relaunch: () => Promise<void>;
    showItemInFolder: (path: string) => Promise<void>;
    setOpenAtLogin: (openAtLogin: boolean) => Promise<void>;
    setTheme: (theme: Theme) => Promise<void>;
    setMenuBarVisible: (visible: boolean) => Promise<void>;
    checkUpdate: () => Promise<unknown>;
    getPathForFile: (file: File) => string;
    execFile: (file: string, args: string[]) => Promise<string>;
    createSubWindow: (opts: SubWindowOptions) => Promise<boolean>;
  };
  config: {
    save: (newConfig: AppConfig) => Promise<void>;
    get: (key: string) => Promise<any>;
    getAll: () => Promise<AppConfig>;
    set: <K extends keyof AppConfig>(key: K, value: AppConfig[K]) => Promise<void>;
  };
  mergeAssMp4: (
    files: {
      videoFilePath: string;
      assFilePath?: string | null;
      outputPath: string;
      hotProgressFilePath: string | undefined;
    },
    options?: {
      removeOrigin: boolean;
      override: boolean;
      startTimestamp?: number;
      timestampFont?: string;
    },
    ffmpegOptions?: FfmpegOptions,
  ) => Promise<{ taskId: string }>;

  openDirectory: (opts?: OpenDirectoryOptions) => Promise<string | undefined>;
  openFile: (options: OpenDialogOptions) => Promise<string[] | undefined>;
  showSaveDialog: (options?: SaveDialogOptions) => Promise<string | undefined>;
  openExternal: (url: string) => Promise<void>;
  openPath: (path: string) => Promise<void>;
  exits: (path: string) => Promise<boolean>;

  openSetting: (callback: (...args: any[]) => void) => void;
  openLog: (callback: (...args: any[]) => void) => void;
  openChangelog: (callback: (...args: any[]) => void) => void;
  onMainNotify: (callback: (...args: any[]) => void) => void;
}
