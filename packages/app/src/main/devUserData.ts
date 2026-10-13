import fs from "node:fs";
import { app } from "electron";

/**
 * dev（未打包）时把 userData 切到独立目录，避免和已安装版本互相干扰。
 *
 * 打包版和 dev 版的 app 名同为 biliLive-tools，默认都解析到 %APPDATA%\biliLive-tools，
 * 两边同时运行会：
 *  - 抢 app.requestSingleInstanceLock()，后启动的那个直接退出
 *  - 同时写 app.db / dm0.db，SQLite 出现 BUSY / 数据错乱
 *  - 互相覆盖 appConfig.json、presets 等配置，日志也混进同一个 main.log
 *
 * 切到 <userData>-dev 之后，dev 版可以和已安装版本（比如正在实时录制的那个）同时跑。
 *
 * 必须早于 requestSingleInstanceLock() 和其它 userData 读取，所以它得是主进程入口的第一个 import。
 */
if (!app.isPackaged) {
  const devUserData = `${app.getPath("userData")}-dev`;
  fs.mkdirSync(devUserData, { recursive: true });
  app.setPath("userData", devUserData);
}
