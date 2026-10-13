// 必须放在最前面：dev 的 userData 隔离要在抢单实例锁、读配置之前生效
import "./devUserData";
import { join } from "node:path";
import { readFileSync, rmSync } from "node:fs";
import semver from "semver";
import contextMenu from "electron-context-menu";
import {
  app,
  dialog,
  BrowserWindow,
  ipcMain,
  shell,
  Tray,
  Menu,
  net,
  nativeTheme,
  crashReporter,
  nativeImage,
  powerSaveBlocker,
} from "electron";
import { createContainer } from "awilix";

import installExtension from "electron-devtools-installer";
import { electronApp, optimizer, is } from "@electron-toolkit/utils";

import log from "./utils/log";
import { notify } from "./utils/index";
import { PowerSaveController } from "./utils/powerSave";
import { init } from "@biliLive-tools/shared";
import { serverStart } from "@biliLive-tools/http";

import { cookieHandlers } from "./cookie";
import { commonHandlers } from "./common";
import { configHandlers, ffmpegHandlers } from "./handlers";
// import icon from "../../resources/icon.png?asset";
import { __dirname2, getConfigPath } from "./appConstant";

import type { OpenDialogOptions } from "../types";
import type { IpcMainInvokeEvent, IpcMain, SaveDialogOptions } from "electron";
import type { Theme, GlobalConfig } from "@biliLive-tools/types";

export let mainWin: BrowserWindow;
export let container = createContainer();
const powerSaveController = new PowerSaveController(powerSaveBlocker);

const SENTRY_CRASH_DSN =
  "https://aa05399bf7cf8b619177be3284d28fc8@o4511547045576704.ingest.us.sentry.io/4511547052720128";

const getSentryMinidumpSubmitURL = (dsn: string) => {
  try {
    const url = new URL(dsn);
    const projectId = url.pathname.replace(/^\/+/, "");
    if (!projectId || !url.username) {
      throw new Error("Missing Sentry project id or public key.");
    }

    return `${url.protocol}//${url.host}/api/${projectId}/minidump/?sentry_key=${url.username}`;
  } catch (error) {
    log.warn("Failed to parse Sentry crash DSN.", error);
    return undefined;
  }
};

contextMenu({
  showSelectAll: false,
  showSearchWithGoogle: false,
  showSaveImageAs: false,
});
if (process.argv.includes("--disable-gpu")) {
  app.disableHardwareAcceleration();
}

/**
 * 主窗口的位置 / 尺寸 / 最大化状态交给 Electron 原生的 windowStatePersistence 管理。
 *
 * 原生实现会把状态连同当时的显示器工作区一起写进 `userData/Local State` 的
 * `windowStates.<name>`，恢复时按当前显示器布局自动修正——比之前手写的「x/y 为负就
 * 丢弃」靠谱得多（副屏拔掉后旧坐标落在屏幕外，旧判断是识别不出来的）。
 *
 * 两个必须留意的行为：
 *  - 最大化状态在窗口 show() 时才应用，不是构造时——所以下面不要去读刚建好的窗口的
 *    isMaximized()，那时候必然是 false。
 *  - 落盘是**异步**的（实测约 200ms），改完窗口状态立刻 app.exit(0) 会丢掉这次变更。
 *    relaunch() 里因此有一处显式等待。
 */
const MAIN_WINDOW_NAME = "main";
const DEFAULT_WINDOW_SIZE = { width: 900, height: 750 };

/**
 * <= 3.22 的窗口状态存在 `userData/window-state.json`（就是 electron-store 的普通
 * JSON 文件）。改用原生持久化后没人再读它，这里只在升级后的首次启动把老数据当作构造
 * 参数默认值带过去，避免老用户的窗口尺寸 / 位置被重置回 900x750；带完即删。
 *
 * 用 fs 直读而不是引回 electron-store：后者一构造就会把文件建出来，全新安装会凭空
 * 多出一个空的 window-state.json。
 *
 * 原生持久化一旦有记录就会覆盖这些构造参数，所以即便这段迁移逻辑将来出问题，
 * 也只影响升级后的第一次启动。
 */
function takeLegacyWindowState() {
  const legacyPath = join(app.getPath("userData"), "window-state.json");

  let legacy: {
    width?: number;
    height?: number;
    x?: number;
    y?: number;
    isMaximized?: boolean;
  };
  try {
    legacy = JSON.parse(readFileSync(legacyPath, "utf-8"))?.winBounds;
  } catch {
    // 文件不存在，或者不是预期里的 JSON（比如被手动改坏了）
    return undefined;
  }

  rmSync(legacyPath, { force: true });
  if (!legacy?.width || !legacy?.height) return undefined;
  return legacy;
}

/** 把旧状态转成 BrowserWindow 构造参数；坐标明显无效时退回默认位置 */
function legacyBoundsToOptions(legacy: NonNullable<ReturnType<typeof takeLegacyWindowState>>) {
  const valid = (v: number | undefined): v is number => typeof v === "number" && v >= 0;
  return {
    width: legacy.width as number,
    height: legacy.height as number,
    ...(valid(legacy.x) && valid(legacy.y) ? { x: legacy.x, y: legacy.y } : {}),
  };
}

const registerHandlers = (
  ipcMain: IpcMain,
  handlers: {
    [key: string]: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => any;
  },
) => {
  Object.keys(handlers).forEach((key) => {
    ipcMain.handle(key, handlers[key]);
  });
};

const genHandler = (ipcMain: IpcMain) => {
  // 通用函数
  ipcMain.handle("dialog:openDirectory", openDirectory);
  ipcMain.handle("dialog:openFile", openFile);
  ipcMain.handle("dialog:save", saveDialog);
  ipcMain.handle("common:relaunch", relaunch);
  ipcMain.handle("common:setOpenAtLogin", setOpenAtLogin);
  ipcMain.handle("common:setTheme", setTheme);
  ipcMain.handle("common:setMenuBarVisible", setMenuBarVisible);
  ipcMain.handle("common:createSubWindow", (_event, options) => createSubWindow(options));
  ipcMain.handle("common:checkUpdate", manualCheckUpdate);

  registerHandlers(ipcMain, ffmpegHandlers);
  registerHandlers(ipcMain, configHandlers);
  registerHandlers(ipcMain, commonHandlers);
  registerHandlers(ipcMain, cookieHandlers);
};

function createSubWindow(options: {
  routeName: string;
  hideAside?: boolean;
  hideMenuBar?: boolean;
  maximized?: boolean;
  query?: Record<string, string>;
}) {
  const css = `
  .layout>div>aside {
    display: none;
  }
  .main-container{
    margin: 0 !important;
  }  
  `;
  const hideMenuBar = !!options.hideMenuBar;
  const queryString = options.query ? new URLSearchParams(options.query).toString() : "";
  const route = queryString ? `${options.routeName}?${queryString}` : options.routeName;

  const subWindow = new BrowserWindow({
    webPreferences: {
      preload: join(__dirname2, "../preload/index.mjs"),
      sandbox: false,
      webSecurity: false,
    },
    autoHideMenuBar: hideMenuBar,
  });

  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    const url = process.env["ELECTRON_RENDERER_URL"] + `/#/${route}`;
    subWindow.loadURL(url);
  } else {
    subWindow.loadFile(join(__dirname2, "../renderer/index.html"), {
      // Hash 路由只会解析 # 后面的查询参数。loadFile 的 query 会被放在
      // index.html 与 hash 之间，导致 useRoute().query 在生产环境中为空。
      hash: route,
    });
  }

  subWindow.webContents.on("did-finish-load", () => {
    if (options.hideAside) {
      subWindow.webContents.insertCSS(css);
    }
  });
  // subWindow.webContents.openDevTools();
  if (options.maximized) {
    subWindow.maximize();
  }
  return true;
  return subWindow;
}

function createWindow(): void {
  const legacyWindowState = takeLegacyWindowState();

  // Create the browser window.
  const mainWindow = new BrowserWindow({
    name: MAIN_WINDOW_NAME,
    windowStatePersistence: true,
    ...DEFAULT_WINDOW_SIZE,
    ...(legacyWindowState ? legacyBoundsToOptions(legacyWindowState) : {}),
    show: false,
    autoHideMenuBar: false,
    minHeight: 400,
    minWidth: 600,
    ...(process.platform === "linux" ? { icon: join(__dirname2, "../../resources/icon.png") } : {}),
    webPreferences: {
      preload: join(__dirname2, "../preload/index.mjs"),
      sandbox: false,
      webSecurity: false,
      // nodeIntegrationInWorker: true,
    },
  });
  // 旧数据里的最大化状态没法通过构造参数传，只能建完再补（实测隐藏窗口上调 maximize()
  // 同样会被原生持久化记下来），这样老用户升级后第一次启动也能保持原样。
  if (legacyWindowState?.isMaximized) {
    mainWindow.maximize();
  }

  mainWindow.on("ready-to-show", () => {
    if (is.dev) {
      // mainWindow.webContents.openDevTools();
      mainWindow.showInactive();
    } else {
      // 用来静默启动
      const isHidden = process.argv.includes("--hidden");
      if (isHidden) {
        mainWin.setSkipTaskbar(true);
      } else {
        mainWindow.show();
      }
    }
  });

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(join(__dirname2, "../renderer/index.html"));
  }
  mainWin = mainWindow;
  const content = mainWindow.webContents;

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // const url = details.url;
    if (url.startsWith("http")) {
      shell.openExternal(url);
      return { action: "deny" };
    } else {
      return { action: "allow" };
    }
  });

  content.on("render-process-gone", (_event, details) => {
    log.error(`render-process-gone: ${JSON.stringify(details)}`);
  });
  // content.on("unresponsive", (event) => {
  //   log.error(`unresponsive: ${JSON.stringify(event)}`);
  // });
  content.on("preload-error", (_event, preloadPath, error) => {
    log.error(`preload-error: ${preloadPath},${error}`);
  });

  // 添加更多渲染进程相关的事件监听
  content.on("crashed" as any, (_event, killed) => {
    log.error("=== 渲染进程崩溃 (Renderer Process Crashed) ===");
    log.error("是否被杀死:", killed);
    log.error("崩溃时间:", new Date().toISOString());
    log.error("进程ID:", content.getOSProcessId());
    log.error("=== 渲染进程崩溃结束 ===");
  });

  content.on("unresponsive" as any, () => {
    log.error("=== 渲染进程无响应 (Renderer Process Unresponsive) ===");
    log.error("无响应时间:", new Date().toISOString());
    log.error("进程ID:", content.getOSProcessId());
    log.error("=== 渲染进程无响应结束 ===");
  });

  content.on("responsive" as any, () => {
    log.info("=== 渲染进程恢复响应 (Renderer Process Responsive) ===");
    log.info("恢复时间:", new Date().toISOString());
    log.info("进程ID:", content.getOSProcessId());
    log.info("=== 渲染进程恢复响应结束 ===");
  });

  content.on(
    "did-fail-load" as any,
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      log.error("=== 页面加载失败 (Page Load Failed) ===");
      log.error("错误代码:", errorCode);
      log.error("错误描述:", errorDescription);
      log.error("验证URL:", validatedURL);
      log.error("是否主框架:", isMainFrame);
      log.error("失败时间:", new Date().toISOString());
      log.error("=== 页面加载失败结束 ===");
    },
  );

  content.on(
    "did-fail-provisional-load" as any,
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      log.error("=== 临时页面加载失败 (Provisional Load Failed) ===");
      log.error("错误代码:", errorCode);
      log.error("错误描述:", errorDescription);
      log.error("验证URL:", validatedURL);
      log.error("是否主框架:", isMainFrame);
      log.error("失败时间:", new Date().toISOString());
      log.error("=== 临时页面加载失败结束 ===");
    },
  );

  // content.on("console-message" as any, (_event, level, message, line, sourceId) => {
  //   if (level >= 2) {
  //     // 只记录警告和错误级别的控制台消息
  //     log.warn("=== 渲染进程控制台消息 ===");
  //     log.warn("级别:", level);
  //     log.warn("消息:", message);
  //     log.warn("行号:", line);
  //     log.warn("源ID:", sourceId);
  //     log.warn("时间:", new Date().toISOString());
  //     log.warn("=== 渲染进程控制台消息结束 ===");
  //   }
  // });

  // 触发关闭时触发
  mainWin.on("close", (event) => {
    const appConfig = container.resolve("appConfig");

    const closeToTray = appConfig.get("closeToTray");
    event.preventDefault();

    if (process.platform === "darwin") {
      quit();
      return;
    }

    if (closeToTray) {
      mainWin.hide();
      mainWin.setSkipTaskbar(true);
    } else {
      quit();
    }
  });
  // 窗口最小化
  mainWin.on("minimize", () => {
    const appConfig = container.resolve("appConfig");
    const minimizeToTray = appConfig.get("minimizeToTray");
    if (minimizeToTray) {
      // event.preventDefault();
      // mainWin.hide();
      mainWin.setSkipTaskbar(true);
    }
  });

  // 新建托盘
  const iconPath = join(__dirname2, "../../resources/icon.png");
  const trayIcon = nativeImage.createFromPath(iconPath);

  // macOS 需要使用模板图片模式来正确显示托盘图标大小和颜色
  if (process.platform === "darwin") {
    trayIcon.setTemplateImage(true);
  }

  const tray = new Tray(trayIcon);
  // 托盘名称
  tray.setToolTip("biliLive-tools");
  // 托盘菜单
  const contextMenu = Menu.buildFromTemplate([
    {
      label: "显示",
      click: () => {
        mainWin.setSkipTaskbar(false);
        mainWin.show();
      },
    },
    {
      label: "重启",
      click: () => {
        relaunch();
      },
    },
    {
      label: "退出",
      click: async () => {
        quit();
      },
    },
  ]);
  // 载入托盘菜单
  tray.setContextMenu(contextMenu);
  // 双击触发
  tray.on("double-click", () => {
    mainWin.isVisible() ? mainWin.hide() : mainWin.show();
    mainWin.isVisible() ? mainWin.setSkipTaskbar(false) : mainWin.setSkipTaskbar(true);
  });
}

function createMenu(): void {
  const isMac = process.platform === "darwin";

  const template: Electron.MenuItemConstructorOptions[] = [];

  // macOS 需要 appMenu 才能让 Cmd+Q 等系统快捷键正常工作
  if (isMac) {
    template.push({
      role: "appMenu",
    });
  }

  template.push(
    {
      label: "文件",
      submenu: [
        {
          label: "设置",
          click: () => {
            mainWin.show();
            mainWin.webContents.send("open-setting");
          },
        },
        {
          label: "查看log",
          click: () => {
            mainWin.show();
            mainWin.webContents.send("open-log");
          },
        },
        {
          label: "打开配置文件夹",
          click: async () => {
            const { userDataPath } = await getConfigPath();
            shell.openPath(userDataPath);
          },
        },
        {
          label: "打开log文件夹",
          click: () => {
            shell.openPath(app.getPath("logs"));
          },
        },
        { type: "separator" },
        {
          label: "退出",
          accelerator: isMac ? "Cmd+Q" : "Alt+F4",
          click: async () => {
            quit();
          },
        },
      ],
    },
    // Edit 菜单提供 Cmd+C / Cmd+V / Cmd+A 等标准快捷键
    {
      role: "editMenu",
    },
    {
      label: "开发者工具",
      role: "viewMenu",
    },
    {
      label: "视图",
      submenu: [
        {
          label: "后退",
          accelerator: isMac ? "Cmd+[" : "Alt+Left",
          click: () => {
            const history = BrowserWindow.getFocusedWindow()?.webContents.navigationHistory;
            if (history?.canGoBack()) {
              history.goBack();
            }
          },
        },
        {
          label: "前进",
          accelerator: isMac ? "Cmd+]" : "Alt+Right",
          click: () => {
            const history = BrowserWindow.getFocusedWindow()?.webContents.navigationHistory;
            if (history?.canGoForward()) {
              history.goForward();
            }
          },
        },
        { type: "separator" },
        {
          label: "新建窗口",
          accelerator: "CmdOrCtrl+N",
          click: () => {
            createSubWindow({ routeName: "" });
          },
        },
      ],
    },
    {
      label: "帮助",
      submenu: [
        {
          label: "官方文档",
          click: async () => {
            shell.openExternal("https://docs.irenmu.com/");
          },
        },
        {
          label: "更新记录",
          click: () => {
            mainWin.show();
            mainWin.webContents.send("open-changelog");
          },
        },
        {
          label: "赞助",
          click: async () => {
            shell.openExternal("https://afdian.com/a/renmu123");
          },
        },
        {
          label: "检测更新",
          click: async () => {
            try {
              const status = await checkUpdate();
              if (status) {
                dialog.showMessageBox(mainWin, {
                  message: "当前已经是最新版本",
                  buttons: ["确认"],
                });
              }
            } catch (error) {
              log.error(error);
              const confirm = await dialog.showMessageBox(mainWin, {
                message: "检查更新失败，请前往仓库查看",
                buttons: ["取消", "确认"],
              });
              if (confirm.response === 1) {
                shell.openExternal("https://github.com/renmu123/biliLive-tools/releases");
              }
            }
          },
        },
      ],
    },
  );

  // macOS 需要 windowMenu 来提供窗口管理功能
  if (isMac) {
    template.push({
      role: "windowMenu",
    });
  }

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

const canQuit = async () => {
  const taskQueue = container.resolve("taskQueue");
  const recorderManager = container.resolve("recorderManager");

  const tasks = taskQueue.list();
  const isRunningTask = tasks.some((task) =>
    ["running", "paused", "pending"].includes(task.status),
  );
  let isRecordingTask = recorderManager.manager.recorders.some(
    (item) => item.state === "recording",
  );
  if (isRunningTask || isRecordingTask) {
    const confirm = await dialog.showMessageBox(mainWin, {
      message: "检测到有未完成的任务或录制，是否退出？",
      buttons: ["取消", "强制退出", "退出"],
    });
    if (confirm.response === 2) {
      // 手动停止正在录制的直播
      for (const recorder of recorderManager.manager.recorders) {
        if (recorder.state === "recording") {
          await recorderManager.manager.stopRecord(recorder.id);
        }
      }
      return true;
    } else if (confirm.response === 1) {
      return true;
    } else {
      return false;
    }
  }
  return true;
};

// 退出应用时检测任务
const quit = async () => {
  try {
    const canQuited = await canQuit();
    if (canQuited) {
      mainWin.destroy();
      app.quit();
    }
  } catch (e) {
    log.error("quit error", e);
    mainWin.destroy();
    app.quit();
  }
};

export const relaunch = async () => {
  const canQuited = await canQuit();
  if (!canQuited) return;

  // 沿用旧行为：重启后不带着最大化状态回来。
  //
  // 原生持久化是异步落盘的（实测需要 ~200ms），unmaximize() 之后直接 app.exit(0)
  // 会把这次变更丢掉，所以这里必须显式等一下；顺手把窗口藏起来，免得用户看到窗口
  // 先缩小再重启。窗口已销毁时（比如另一条退出路径先走完）直接跳过。
  if (!mainWin.isDestroyed()) {
    mainWin.unmaximize();
    mainWin.hide();
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  app.relaunch();
  app.exit(0);
};

export const setOpenAtLogin = (_event: IpcMainInvokeEvent, openAtLogin: boolean) => {
  if (process.platform === "win32") {
    // 兼容性清理
    app.setLoginItemSettings({
      openAtLogin: false,
      name: "com.electron",
    });
  }

  app.setLoginItemSettings({
    openAtLogin,
    args: ["--hidden"],
  });
};

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  const sentryCrashSubmitURL = getSentryMinidumpSubmitURL(SENTRY_CRASH_DSN);
  crashReporter.start({
    uploadToServer: false,
    submitURL: sentryCrashSubmitURL,
    compress: true,
    rateLimit: true,
    globalExtra: {
      product: "biliLive-tools",
    },
  });
  app.whenReady().then(() => {
    electronApp.setAppUserModelId("com.electron.biliLiveTools");
    installExtension("nhdogjmejiglipccpnnnanhbledajbpd")
      .then(({ name }) => log.debug(`Added Extension:  ${name}`))
      .catch((err) => log.debug("An error occurred: ", err));

    // Default open or close DevTools by F12 in development
    // and ignore CommandOrControl + R in production.
    // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
    app.on("browser-window-created", (_, window) => {
      optimizer.watchWindowShortcuts(window);
    });

    createWindow();
    createMenu();
    genHandler(ipcMain);
    appInit();

    app.on("activate", function () {
      // On macOS it's common to re-create a window in the app when the
      // dock icon is clicked and there are no other windows open.
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  process.on("uncaughtException", function (error) {
    log.error("=== 未捕获异常 (Uncaught Exception) ===");
    log.error("错误信息:", error.message);
    log.error("错误堆栈:", error.stack);

    if (error.message.includes("listen EADDRINUSE")) {
      setTimeout(() => {
        const appConfig = container.resolve("appConfig");
        notify(mainWin.webContents, {
          type: "error",
          content: `检查是否有其他程序占用了${appConfig.get("port")}端口，请尝试更换端口或重启设备`,
        });
      }, 1000);
    }
    log.error("=== 未捕获异常结束 ===");
  });

  process.on("unhandledRejection", function (reason, promise) {
    log.error("拒绝原因:", reason, promise);

    if (reason instanceof Error) {
      log.error("错误名称:", reason.name);
      log.error("错误消息:", reason.message);
      log.error("错误堆栈:", reason.stack);
    }

    // 发送通知到渲染进程
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send("notify", {
        type: "error",
        content: String(reason),
      });
    }
  });

  // 添加更多进程事件监听
  process.on("warning", function (warning) {
    log.warn("=== 进程警告 (Process Warning) ===");
    log.warn("警告名称:", warning.name);
    log.warn("警告消息:", warning.message);
    log.warn("警告堆栈:", warning.stack);
    log.warn("警告代码:", (warning as any).code);
    log.warn("=== 进程警告结束 ===");
  });

  process.on("exit", function (code) {
    log.info("=== 进程退出 (Process Exit) ===");
    log.info("退出代码:", code);
    log.info("退出时间:", new Date().toISOString());
    log.info("=== 进程退出结束 ===");
  });

  process.on("SIGTERM", function () {
    log.info("=== 收到SIGTERM信号 ===");
    log.info("时间:", new Date().toISOString());
    log.info("=== SIGTERM信号处理结束 ===");
  });

  process.on("SIGINT", function () {
    log.info("=== 收到SIGINT信号 ===");
    log.info("时间:", new Date().toISOString());
    log.info("=== SIGINT信号处理结束 ===");
  });

  app.on("second-instance", () => {
    // 有人试图运行第二个实例，我们应该关注我们的窗口
    if (mainWin) {
      if (mainWin.isMinimized()) mainWin.restore();
      if (!mainWin.isVisible()) mainWin.show();
      mainWin.focus();
    }
  });

  // Quit when all windows are closed, except on macOS. There, it's common
  // for applications and their menu bar to stay active until the user quits
  // explicitly with Cmd + Q.
  app.on("window-all-closed", () => {
    log.info("app quit");
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}

// 业务相关的初始化
const appInit = async () => {
  // 记录应用启动信息
  log.info("=== 应用启动信息 ===");
  log.info("应用版本:", app.getVersion());
  log.info("Electron版本:", process.versions.electron);
  log.info("Node版本:", process.versions.node);
  log.info("Chrome版本:", process.versions.chrome);
  log.info("V8版本:", process.versions.v8);
  log.info("操作系统:", process.platform);
  log.info("架构:", process.arch);
  log.info("启动时间:", new Date().toISOString());
  log.info("用户数据路径:", app.getPath("userData"));
  log.info("日志路径:", app.getPath("logs"));
  log.info("=== 应用启动信息结束 ===");

  const {
    APP_CONFIG_PATH,
    FFMPEG_PRESET_PATH,
    VIDEO_PRESET_PATH,
    DANMU_PRESET_PATH,
    LOG_PATH,
    FFMPEG_PATH,
    FFPROBE_PATH,
    DANMUKUFACTORY_PATH,
    MESIO_PATH,
    BILILIVERECORDER_PATH,
    AUDIOWAVEFORM_PATH,
    userDataPath,
  } = await getConfigPath();

  const globalConfig: GlobalConfig = {
    videoPresetPath: VIDEO_PRESET_PATH,
    ffmpegPresetPath: FFMPEG_PRESET_PATH,
    danmuPresetPath: DANMU_PRESET_PATH,
    configPath: APP_CONFIG_PATH,
    logPath: LOG_PATH,
    defaultFfmpegPath: FFMPEG_PATH,
    defaultFfprobePath: FFPROBE_PATH,
    defaultMesioPath: MESIO_PATH,
    defaultBililiveRecorderPath: BILILIVERECORDER_PATH,
    defaultAudioWaveformPath: AUDIOWAVEFORM_PATH,
    defaultDanmakuFactoryPath: DANMUKUFACTORY_PATH,
    userDataPath,
    version: app.getVersion(),
  };
  container = await init(globalConfig);
  const appConfig = container.resolve("appConfig");

  await serverStart(
    {
      port: appConfig.get("port"),
      host: appConfig.get("host"),
      auth: true,
      passKey: appConfig.get("passKey"),
    },
    container,
  );
  nativeTheme.themeSource = appConfig.get("theme");
  const menuBarVisible = appConfig.get("menuBarVisible");
  mainWin.setMenuBarVisibility(menuBarVisible);
  powerSaveController.setEnabled(appConfig.get("preventSystemSleep"));
  appConfig.on("update", (newData, oldData) => {
    if (newData.preventSystemSleep !== oldData.preventSystemSleep) {
      powerSaveController.setEnabled(newData.preventSystemSleep);
    }
  });

  // 检测更新
  if (appConfig.get("autoUpdate")) {
    try {
      await checkUpdate();
    } catch (error) {
      log.error("自动更新检查失败:", error);
    }
  }
  if (appConfig.get("uploadCrashReport")) {
    crashReporter.setUploadToServer(true);
  }
  // taskQueueListen(container);
};

// const taskQueueListen = (container: AwilixContainer) => {
//   const taskQueue = container.resolve("taskQueue");
//   taskQueue.on("task-start", ({ taskId }) => {
//     mainWin.webContents.send("task-start", { taskId: taskId });
//   });
//   taskQueue.on("task-end", ({ taskId }) => {
//     mainWin.webContents.send("task-end", {
//       taskId: taskId,
//       output: taskQueue.queryTask(taskId)?.output,
//     });
//   });
//   taskQueue.on("task-error", ({ taskId }) => {
//     mainWin.webContents.send("task-error", { taskId: taskId });
//   });
//   taskQueue.on("task-progress", ({ taskId }) => {
//     mainWin.webContents.send("task-progress", { taskId: taskId });
//   });
// };

const openDirectory = async (
  _event: IpcMainInvokeEvent,
  opts: {
    defaultPath?: string;
    buttonLabel?: string;
    title?: string;
  } = {},
) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWin, {
    ...opts,
    properties: ["openDirectory"],
  });
  if (canceled) {
    return;
  } else {
    return filePaths[0];
  }
};
const openFile = async (_event: IpcMainInvokeEvent, options: OpenDialogOptions) => {
  const properties: ("openFile" | "multiSelections")[] = ["openFile"];
  if (options.multi) {
    properties.push("multiSelections");
  }

  const { canceled, filePaths } = await dialog.showOpenDialog(mainWin, {
    properties,
    ...options,
  });
  if (canceled) {
    return;
  } else {
    return filePaths;
  }
};

const saveDialog = async (_event: IpcMainInvokeEvent, options: SaveDialogOptions) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWin, options);
  if (canceled) {
    return;
  } else {
    return filePath;
  }
};

const setTheme = (_event: IpcMainInvokeEvent, theme: Theme) => {
  nativeTheme.themeSource = theme;
};

const setMenuBarVisible = (_event: IpcMainInvokeEvent, visible: boolean) => {
  if (mainWin) {
    mainWin.setMenuBarVisibility(visible);
  }
};

const checkUpdate = async () => {
  await app.whenReady();
  const res = await net.fetch(
    "https://githubraw.irenmu.com/renmu123/biliLive-tools/master/package.json",
  );
  const data = await res.json();
  const latestVersion = data.version;
  const version = app.getVersion();

  if (semver.gt(latestVersion, version)) {
    const confirm = await dialog.showMessageBox(mainWin, {
      message: "检测到有新版本，是否前往下载？",
      buttons: ["取消", "备用", "确认"],
    });
    if (confirm.response === 2) {
      shell.openExternal("https://github.com/renmu123/biliLive-tools/releases");
    } else if (confirm.response === 1) {
      shell.openExternal("https://pan.quark.cn/s/6da253a1ecb8");
    }
    return false;
  }
  return true;
};

const manualCheckUpdate = async () => {
  try {
    const status = await checkUpdate();
    if (status) {
      dialog.showMessageBox(mainWin, {
        message: "当前已经是最新版本",
        buttons: ["确认"],
      });
    }
  } catch (error) {
    log.error(error);
    const confirm = await dialog.showMessageBox(mainWin, {
      message: "检查更新失败，请前往仓库查看",
      buttons: ["取消", "确认"],
    });
    if (confirm.response === 1) {
      shell.openExternal("https://github.com/renmu123/biliLive-tools/releases");
    }
  }
};
