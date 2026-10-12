use std::collections::HashMap;
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogResult};
use tauri_plugin_opener::OpenerExt;

use crate::config;
use crate::AppState;

static SUB_WINDOW_COUNTER: AtomicUsize = AtomicUsize::new(1);
static FIRST_CONFIG_GET: AtomicBool = AtomicBool::new(true);

#[tauri::command]
pub fn config_get_all(state: State<AppState>) -> Result<serde_json::Value, String> {
    if FIRST_CONFIG_GET.swap(false, Ordering::SeqCst) {
        config::log_line(
            &state.user_data_dir,
            &format!(
                "渲染层首次获取配置 ({}ms)",
                state.started_at.elapsed().as_millis()
            ),
        );
    }
    Ok(config::read_json(&state.user_data_dir.join("appConfig.json")))
}

#[tauri::command]
pub fn config_get(state: State<AppState>, key: String) -> Result<serde_json::Value, String> {
    let value = config::read_json(&state.user_data_dir.join("appConfig.json"));
    Ok(config::get_by_path(&value, &key))
}

/// pending / ready / error
#[tauri::command]
pub fn sidecar_status(state: State<AppState>) -> String {
    state
        .sidecar_status
        .lock()
        .map(|status| status.clone())
        .unwrap_or_else(|_| "pending".to_string())
}

#[tauri::command]
pub fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("读取文件失败 {path}: {e}"))
}

#[tauri::command]
pub fn write_text_file(path: String, data: String) -> Result<(), String> {
    std::fs::write(&path, data).map_err(|e| format!("写入文件失败 {path}: {e}"))
}

#[tauri::command]
pub fn make_dir(path: String) -> Result<(), String> {
    std::fs::create_dir(&path).map_err(|e| format!("创建目录失败 {path}: {e}"))
}

#[tauri::command]
pub fn open_path(app: AppHandle, path: String) -> Result<(), String> {
    app.opener()
        .open_path(&path, None::<&str>)
        .map_err(|e| format!("打开路径失败 {path}: {e}"))
}

#[tauri::command]
pub fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    app.opener()
        .open_url(&url, None::<&str>)
        .map_err(|e| format!("打开链接失败 {url}: {e}"))
}

#[tauri::command]
pub fn show_in_folder(app: AppHandle, path: String) -> Result<(), String> {
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| format!("定位文件失败 {path}: {e}"))
}

#[tauri::command]
pub async fn exec_file(file: String, args: Vec<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut command = Command::new(&file);
        command.args(&args);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let output = command.run_capture()?;
        Ok(output)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 运行并捕获输出（与 Electron 版 execFile 行为对齐：失败时 reject，成功返回 stdout）
trait RunCapture {
    fn run_capture(&mut self) -> Result<String, String>;
}

impl RunCapture for Command {
    fn run_capture(&mut self) -> Result<String, String> {
        let output = self.output().map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }
}

#[tauri::command]
pub fn set_theme(app: AppHandle, theme: String) -> Result<(), String> {
    let theme = match theme.as_str() {
        "dark" => Some(tauri::Theme::Dark),
        "light" => Some(tauri::Theme::Light),
        _ => None,
    };
    if let Some(window) = app.get_webview_window("main") {
        window.set_theme(theme).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn set_menu_bar_visible(visible: bool) -> Result<(), String> {
    // Windows 菜单栏是 Electron 概念，Tauri 下无等价物（已知差异 D2），保留空实现
    let _ = visible;
    Ok(())
}

#[tauri::command]
pub fn set_open_at_login(open_at_login: bool) -> Result<(), String> {
    // Phase 2：接入 tauri-plugin-autostart
    let _ = open_at_login;
    Ok(())
}

#[tauri::command]
pub fn relaunch(app: AppHandle) {
    app.restart();
}

#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<(), String> {
    let current_version = app.package_info().version.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let agent = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(15))
            .try_proxy_from_env(true)
            .build();
        let fetch = agent
            .get("https://githubraw.irenmu.com/renmu123/biliLive-tools/master/package.json")
            .call()
            .map_err(|e| e.to_string())
            .and_then(|response| {
                response
                    .into_json::<serde_json::Value>()
                    .map_err(|e| e.to_string())
            });

        match fetch {
            Ok(data) => match data.get("version").and_then(|v| v.as_str()) {
                Some(latest_version)
                    if semver::Version::parse(latest_version)
                        .map(|latest| latest > current_version)
                        .unwrap_or(false) =>
                {
                    let choice = app
                        .dialog()
                        .message("检测到有新版本，是否前往下载？")
                        .title("检查更新")
                        .buttons(MessageDialogButtons::OkCancelCustom(
                            "前往下载".into(),
                            "取消".into(),
                        ))
                        .blocking_show_with_result();
                    if choice == MessageDialogResult::Custom("前往下载".to_string()) {
                        let _ = app.opener().open_url(
                            "https://github.com/renmu123/biliLive-tools/releases",
                            None::<&str>,
                        );
                    }
                }
                Some(_) => {
                    app.dialog()
                        .message("当前已经是最新版本")
                        .title("检查更新")
                        .buttons(MessageDialogButtons::Ok)
                        .blocking_show();
                }
                None => {
                    return Err("检查更新失败：响应中缺少版本信息".to_string());
                }
            },
            Err(error) => {
                let choice = app
                    .dialog()
                    .message("检查更新失败，请前往仓库查看")
                    .title("检查更新")
                    .buttons(MessageDialogButtons::OkCancelCustom(
                        "打开仓库".into(),
                        "取消".into(),
                    ))
                    .blocking_show_with_result();
                if choice == MessageDialogResult::Custom("打开仓库".to_string()) {
                    let _ = app.opener().open_url(
                        "https://github.com/renmu123/biliLive-tools/releases",
                        None::<&str>,
                    );
                }
                config::log_line(
                    &app.state::<AppState>().user_data_dir,
                    &format!("检查更新失败: {error}"),
                );
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubWindowOptions {
    pub route_name: String,
    pub hide_aside: Option<bool>,
    pub hide_menu_bar: Option<bool>,
    pub maximized: Option<bool>,
    pub query: Option<HashMap<String, String>>,
}

const HIDE_ASIDE_SCRIPT: &str = r#"
(function () {
  var css = ".layout>div>aside { display: none; } .main-container { margin: 0 !important; }";
  function inject() {
    var style = document.createElement("style");
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", inject);
  } else {
    inject();
  }
})();
"#;

#[tauri::command]
pub fn create_sub_window(app: AppHandle, opts: SubWindowOptions) -> Result<bool, String> {
    use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};

    let mut route = opts.route_name.clone();
    if let Some(query) = &opts.query {
        let query_string = query
            .iter()
            .map(|(k, v)| {
                format!(
                    "{}={}",
                    utf8_percent_encode(k, NON_ALPHANUMERIC),
                    utf8_percent_encode(v, NON_ALPHANUMERIC)
                )
            })
            .collect::<Vec<_>>()
            .join("&");
        if !query_string.is_empty() {
            route = format!("{route}?{query_string}");
        }
    }

    let label = format!("sub-{}", SUB_WINDOW_COUNTER.fetch_add(1, Ordering::SeqCst));
    let url = WebviewUrl::App(format!("index.html#/{route}").into());
    let mut builder = WebviewWindowBuilder::new(&app, &label, url)
        .title("biliLive-tools")
        .inner_size(1200.0, 800.0);

    if opts.hide_aside.unwrap_or(false) {
        builder = builder.initialization_script(HIDE_ASIDE_SCRIPT);
    }
    let _ = opts.hide_menu_bar;

    let window = builder.build().map_err(|e| format!("创建子窗口失败: {e}"))?;
    if opts.maximized.unwrap_or(false) {
        let _ = window.maximize();
    }
    Ok(true)
}
