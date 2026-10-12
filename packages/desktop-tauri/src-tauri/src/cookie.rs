use std::time::Duration;

use tauri::webview::Cookie;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// 与 Electron 版保持一致的固定 UA（部分平台会检测自动化特征）
const LOGIN_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36 Edg/115.0.1901.188";

fn platform_info(platform: &str) -> Result<(&'static str, &'static str), String> {
    match platform {
        "baidu" => Ok(("https://pan.baidu.com/disk/main", "pan.baidu.com")),
        "xhs" => Ok(("https://www.xiaohongshu.com/", "www.xiaohongshu.com")),
        "douyin" => Ok(("https://www.douyin.com/", ".douyin.com")),
        other => Err(format!("不支持的登录平台: {other}")),
    }
}

fn domain_matches(cookie_domain: Option<&str>, domain: &str) -> bool {
    match cookie_domain {
        Some(cookie_domain) => {
            cookie_domain == domain
                || cookie_domain.trim_start_matches('.') == domain.trim_start_matches('.')
        }
        None => false,
    }
}

fn collect_cookies(cookies: &[Cookie<'static>], domain: &str) -> String {
    cookies
        .iter()
        .filter(|cookie| domain_matches(cookie.domain(), domain))
        .map(|cookie| format!("{}={}", cookie.name(), cookie.value()))
        .collect::<Vec<_>>()
        .join("; ")
}

/// 打开登录窗口，等待用户登录后关闭窗口，再读取 cookie。
///
/// 注意：Windows 下在同步命令或事件处理器中读取 cookie 会死锁，
/// 因此这里使用 async 命令 + 独立线程轮询（见 tauri `WebviewWindow::cookies` 文档）。
#[tauri::command]
pub async fn cookie_login(app: AppHandle, platform: String) -> Result<String, String> {
    let (url, domain) = platform_info(&platform)?;
    let label = format!("login-{platform}");

    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.close();
    }

    let parsed = url
        .parse()
        .map_err(|e| format!("登录地址解析失败 {url}: {e}"))?;
    let window = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(parsed))
        .title("登录")
        .inner_size(1200.0, 800.0)
        .user_agent(LOGIN_UA)
        .build()
        .map_err(|e| format!("创建登录窗口失败: {e}"))?;

    let wait_app = app.clone();
    let wait_label = label.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut cookies_text: Option<String> = None;
        while wait_app.get_webview_window(&wait_label).is_some() {
            if let Ok(cookies) = window.cookies() {
                let text = collect_cookies(&cookies, domain);
                if !text.is_empty() {
                    cookies_text = Some(text);
                }
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        cookies_text.ok_or_else(|| "cookie not found".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
