mod commands;
mod config;
mod cookie;
mod sidecar;

use std::path::PathBuf;
use std::process::Child;
use std::sync::Mutex;

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

pub struct AppState {
    pub user_data_dir: PathBuf,
    pub sidecar: Mutex<Option<Child>>,
    /// pending / ready / error
    pub sidecar_status: Mutex<String>,
    pub started_at: std::time::Instant,
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
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
                .title("biliLive-tools")
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
