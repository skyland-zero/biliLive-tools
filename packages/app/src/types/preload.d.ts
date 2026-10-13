import path from "path-unified";

import { ElectronAPI } from "@electron-toolkit/preload";
import { api } from "../preload/index";

declare global {
  interface Window {
    electron: ElectronAPI;
    api: typeof api;
    path: typeof path;
    isWeb: boolean;
    isFullstack: boolean;
    /** 由 Tauri 初始化脚本注入（只读），用于区分 Electron 桌面端 */
    isTauri?: boolean;
    __APP_VERSION__: string;
  }
}
