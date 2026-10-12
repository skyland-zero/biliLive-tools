mod commands;
mod config;
mod cookie;
mod sidecar;

use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

pub struct AppState {
    pub user_data_dir: PathBuf,
    pub sidecar: Mutex<Option<Child>>,
    /// pending / ready / error
    pub sidecar_status: Mutex<String>,
    pub started_at: std::time::Instant,
}

/// 应用标题：开发态（`tauri dev`）额外带上 `[DEV]`，避免和安装版混在一起分不清。
///
/// `tauri::is_dev()` 等价于「没有启用 tauri 的 `custom-protocol` feature」，
/// 而 `tauri build`（含 NSIS 安装包）会启用它，所以安装版返回 `false`，只有 dev 运行为 `true`。
pub(crate) fn app_title() -> &'static str {
    if tauri::is_dev() {
        "biliLive-tools [DEV]"
    } else {
        "biliLive-tools"
    }
}

/// 读取「关闭到托盘」配置，未配置时默认开启（与 Electron 版 appConfig 默认值一致）
fn read_close_to_tray(user_data_dir: &Path) -> bool {
    let app_config = config::read_json(&user_data_dir.join("appConfig.json"));
    match config::get_by_path(&app_config, "closeToTray") {
        serde_json::Value::Bool(value) => value,
        _ => true,
    }
}

/// 显示并聚焦主窗口
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// 创建托盘图标，行为对齐 Electron 版：
/// 双击托盘显示/隐藏主窗口，右键菜单提供「显示」与「退出」
fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "show", "显示", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip(app_title())
        .menu(&menu)
        .show_menu_on_left_click(false)
        .icon_as_template(cfg!(target_os = "macos"))
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::DoubleClick { .. } = event {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    if window.is_visible().unwrap_or(false) {
                        let _ = window.hide();
                    } else {
                        show_main_window(app);
                    }
                }
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder.build(app)?;
    Ok(())
}

/// 处理主窗口的关闭请求：开启「关闭到托盘」时隐藏窗口，否则退出应用
/// （macOS 与 Electron 版保持一致，直接退出）
fn handle_close_requested(window: &tauri::Window, api: &tauri::CloseRequestApi) {
    if window.label() != "main" {
        return;
    }

    let to_tray = window
        .app_handle()
        .try_state::<AppState>()
        .map(|state| read_close_to_tray(&state.user_data_dir))
        .unwrap_or(true);

    if !to_tray || cfg!(target_os = "macos") {
        window.app_handle().exit(0);
        return;
    }

    api.prevent_close();
    let _ = window.hide();
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                handle_close_requested(window, api);
            }
        })
        .setup(|app| {
            let user_data_dir = config::user_data_dir();
            std::fs::create_dir_all(&user_data_dir)?;
            app.manage(AppState {
                user_data_dir,
                sidecar: Mutex::new(None),
                sidecar_status: Mutex::new("pending".to_string()),
                started_at: std::time::Instant::now(),
            });

            // 先启动 sidecar（后台线程），再创建窗口：
            // 窗口的 WebView2 初始化需要数百毫秒，这样两者的启动时间可以重叠
            let handle = app.handle().clone();
            std::thread::spawn(move || sidecar::start(&handle));

            // 立即创建窗口，渲染层会等待 sidecar 就绪后再挂载
            let window = WebviewWindowBuilder::new(app.handle(), "main", WebviewUrl::App("index.html".into()))
                .title(app_title())
                .inner_size(1280.0, 800.0)
                .min_inner_size(600.0, 400.0)
                .center()
                .on_page_load(|window, payload| {
                    let handle = window.app_handle();
                    if let Some(state) = handle.try_state::<AppState>() {
                        config::log_line(
                            &state.user_data_dir,
                            &format!("页面加载完成 ({}ms): {}", state.started_at.elapsed().as_millis(), payload.url()),
                        );
                    }
                })
                .build()?;
            let _ = window.set_focus();
            {
                let state = app.state::<AppState>();
                config::log_line(
                    &state.user_data_dir,
                    &format!("主窗口已创建 ({}ms)", state.started_at.elapsed().as_millis()),
                );
            }

            // 托盘图标（关闭按钮最小化到托盘的落点）
            setup_tray(app.handle())?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::config_get_all,
            commands::config_get,
            commands::sidecar_status,
            commands::path_exists,
            commands::read_text_file,
            commands::write_text_file,
            commands::make_dir,
            commands::open_path,
            commands::open_external,
            commands::show_in_folder,
            commands::exec_file,
            commands::set_theme,
            commands::set_menu_bar_visible,
            commands::set_open_at_login,
            commands::relaunch,
            commands::check_update,
            commands::create_sub_window,
            cookie::cookie_login,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                sidecar::stop(app_handle);
            }
        });
}
