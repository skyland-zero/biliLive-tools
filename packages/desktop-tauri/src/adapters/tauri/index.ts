/**
 * Tauri 桌面端 window.api 适配层。
 *
 * 与 packages/app/src/preload/index.ts 的行为对齐：
 * - 文件对话框 → tauri-plugin-dialog（经 Rust 侧注册）
 * - 打开路径 / 外部链接 / 定位文件 → Rust 命令（tauri-plugin-opener）
 * - config → 文件读取走 Rust；写入走 sidecar 的 HTTP /config 接口（保证其内存态监听器被触发）
 * - cookie 登录 → Rust 命令（登录窗口 + webview cookie 读取）
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";

import type { AppConfig, Theme } from "@biliLive-tools/types";
import type {
  DialogFilter,
  NotifyData,
  OpenDialogOptions,
  OpenDirectoryOptions,
  SaveDialogOptions,
  SubWindowOptions,
  WindowApi,
} from "./types";

let serverInfo: { port: number; passKey: string; https?: boolean } | undefined;

/** 等待 sidecar 就绪，避免渲染层在启动阶段发出必然失败的请求 */
async function waitForSidecar() {
  if ((await invoke<string>("sidecar_status")) === "ready") return;
  await new Promise<void>((resolve) => {
    let settled = false;
    let unlisten: (() => void) | undefined;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unlisten?.();
      resolve();
    };
    const timer = setTimeout(settle, 60_000);
    listen("sidecar-ready", () => settle())
      .then(async (fn) => {
        unlisten = fn;
        if ((await invoke<string>("sidecar_status")) === "ready") settle();
      })
      .catch(() => settle());
  });
}

/**
 * sidecar 启动时写入的 port/passKey 即是当前运行值。
 * 只缓存一次，之后不刷新（与 Electron 版一致：修改配置不会重启服务）。
 */
async function getServerInfo() {
  if (!serverInfo) {
    const config = await invoke<AppConfig>("config_get_all");
    serverInfo = { port: config.port, passKey: config.passKey, https: config.https };
  }
  return serverInfo;
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const info = await getServerInfo();
  const protocol = info.https ? "https" : "http";
  const res = await fetch(`${protocol}://127.0.0.1:${info.port}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: info.passKey,
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`request ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res;
}

const normalizeFilters = (filters?: DialogFilter[]): DialogFilter[] | undefined => {
  if (!filters?.length) return undefined;
  return filters.map((filter) => ({
    name: filter.name,
    extensions: filter.extensions.filter((ext) => ext !== "*"),
  }));
};

const subscribe = (event: string, callback: (...args: any[]) => void) => {
  listen(event, (e) => callback(e, (e as any).payload)).catch((error) => {
    console.error(`subscribe ${event} failed`, error);
  });
};

const notSupported = (name: string) => () => {
  return Promise.reject(new Error(`${name} 在 Tauri 桌面端暂不支持`));
};

export const api: WindowApi = {
  // renderer 中无调用点，仅保持接口完整
  dbQuery: notSupported("dbQuery"),
  dbList: notSupported("dbList"),
  addWithStreamer: notSupported("addWithStreamer"),
  mergeAssMp4: notSupported("mergeAssMp4"),

  cookie: {
    baiduLogin: () => invoke<string>("cookie_login", { platform: "baidu" }),
    xhsLogin: () => invoke<string>("cookie_login", { platform: "xhs" }),
    douyinLogin: () => invoke<string>("cookie_login", { platform: "douyin" }),
  },

  common: {
    readFile: (path) => invoke<string>("read_text_file", { path }),
    writeFile: (path, data) => invoke<void>("write_text_file", { path, data }),
    mkdir: (path) => invoke<void>("make_dir", { path }),
    relaunch: () => invoke<void>("relaunch"),
    showItemInFolder: (path) => invoke<void>("show_in_folder", { path }),
    setOpenAtLogin: (openAtLogin) => invoke<void>("set_open_at_login", { openAtLogin }),
    setTheme: (theme) => invoke<void>("set_theme", { theme }),
    setMenuBarVisible: (visible) => invoke<void>("set_menu_bar_visible", { visible }),
    checkUpdate: () => invoke<unknown>("check_update"),
    // Tauri 无法通过 HTML5 drop 拿到文件路径（见设计方案 §5.7），
    // 拖拽逻辑将在后续统一替换为 useFileDropZone composable
    getPathForFile: () => {
      console.warn("getPathForFile 在 Tauri 桌面端不可用，请使用文件选择或拖拽适配");
      return "";
    },
    execFile: (file, args) => invoke<string>("exec_file", { file, args }),
    createSubWindow: (opts: SubWindowOptions) => invoke<boolean>("create_sub_window", { opts }),
  },

  config: {
    save: async (newConfig) => {
      await request("/config", { method: "POST", body: JSON.stringify(newConfig) });
    },
    get: (key) => invoke("config_get", { key }),
    getAll: async () => {
      // renderer 启动时第一次调用，此时 sidecar 可能仍在启动中
      await waitForSidecar();
      return invoke<AppConfig>("config_get_all");
    },
    set: async (key, value) => {
      await request("/config/set", { method: "POST", body: JSON.stringify({ key, value }) });
    },
  },

  openDirectory: async (opts: OpenDirectoryOptions = {}) => {
    const result = await openFileDialog({
      directory: true,
      defaultPath: opts.defaultPath,
      title: opts.title,
    });
    return typeof result === "string" ? result : undefined;
  },

  openFile: async (options: OpenDialogOptions) => {
    const result = await openFileDialog({
      multiple: !!options.multi,
      defaultPath: options.defaultPath,
      title: options.title,
      filters: normalizeFilters(options.filters),
    });
    if (result === null) return undefined;
    return Array.isArray(result) ? result : [result];
  },

  showSaveDialog: async (options: SaveDialogOptions = {}) => {
    const result = await saveFileDialog({
      defaultPath: options.defaultPath,
      title: options.title,
      filters: normalizeFilters(options.filters),
    });
    return result ?? undefined;
  },

  openExternal: (url) => invoke<void>("open_external", { url }),
  openPath: (path) => invoke<void>("open_path", { path }),
  exits: (path) => invoke<boolean>("path_exists", { path }),

  openSetting: (callback) => subscribe("open-setting", callback),
  openLog: (callback) => subscribe("open-log", callback),
  openChangelog: (callback) => subscribe("open-changelog", callback),
  onMainNotify: (callback) => subscribe("notify", callback),
};

export function installWindowApi() {
  (window as any).api = api;
}

export type { NotifyData, Theme };
