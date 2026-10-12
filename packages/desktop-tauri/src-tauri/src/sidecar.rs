use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

use crate::config;
use crate::AppState;

const HEALTH_TIMEOUT: Duration = Duration::from_secs(40);

/// 启动 sidecar 并做健康检查，结束后更新状态并通知前端
pub fn start(app: &AppHandle) {
    let user_data = {
        let state = app.state::<AppState>();
        state.user_data_dir.clone()
    };

    let status = match start_sidecar(app, &user_data) {
        Ok(()) => "ready",
        Err(ref error) => {
            config::log_line(&user_data, &format!("sidecar 启动失败: {error}"));
            eprintln!("sidecar 启动失败: {error}");
            "error"
        }
    };

    {
        let state = app.state::<AppState>();
        let locked = state.sidecar_status.lock();
        match locked {
            Ok(mut guard) => *guard = status.to_string(),
            Err(_) => eprintln!("sidecar 状态锁获取失败"),
        }
    }
    let _ = app.emit("sidecar-ready", status == "ready");
}

fn start_sidecar(app: &AppHandle, user_data: &Path) -> Result<(), String> {
    std::fs::create_dir_all(user_data).map_err(|e| format!("创建用户数据目录失败: {e}"))?;

    // 1. 读取/初始化 appConfig.json 中的 port、passKey
    let app_config_path = user_data.join("appConfig.json");
    let mut app_config = load_app_config(&app_config_path);
    let preferred_port = app_config
        .get("port")
        .and_then(|v| v.as_u64())
        .filter(|p| *p > 0 && *p < 65536)
        .unwrap_or(18010) as u16;
    let pass_key = app_config
        .get("passKey")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(generate_pass_key);

    // 2. 端口探测：从配置端口向上找可用端口
    let port = pick_port(preferred_port);
    app_config["port"] = json!(port);
    app_config["passKey"] = json!(pass_key);
    config::write_json(&app_config_path, &app_config)?;

    // 3. 生成 CLI 侧配置文件
    let cli_config_path = user_data.join("config.json");
    let cli_config = json!({
        "port": port,
        "host": "127.0.0.1",
        "configFolder": user_data.to_string_lossy(),
        "ffmpegPath": bin_path(app, "ffmpeg"),
        "ffprobePath": bin_path(app, "ffprobe"),
        "mesioPath": bin_path(app, "mesio"),
        "bililiveRecorderPath": bin_path(app, "BililiveRecorder.Cli"),
        "audiowaveformPath": bin_path(app, "audiowaveform"),
        "danmakuFactoryPath": bin_path(app, "DanmakuFactory"),
        "logPath": user_data.join("main.log").to_string_lossy(),
    });
    config::write_json(&cli_config_path, &cli_config)?;
    warn_missing_bins(user_data, &cli_config);

    // 4. 启动 node sidecar
    let node = node_path(app);
    let cli = cli_entry_path(app);
    config::log_line(
        user_data,
        &format!(
            "启动 sidecar ({}ms): node={} cli={} port={port}",
            elapsed_ms(app),
            node.display(),
            cli.display()
        ),
    );

    let mut command = Command::new(&node);
    command
        // `openai@4 -> node-fetch@2 -> whatwg-url@5 -> tr46@0.0.3` 里 `require("punycode")`
        // 会触发 DEP0040，是 2016 年的老包引入的纯警告，功能无影响。
        // 这里精准静音，避免污染 sidecar.log（Electron 版同样有这条）。
        .arg("--disable-warning=DEP0040")
        .arg(&cli)
        .arg("server")
        .arg("--config")
        .arg(&cli_config_path)
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .env("BILILIVE_TOOLS_PASSKEY", &pass_key)
        // 让 node 缓存编译产物（Node 22+），显著缩短后续启动时间
        .env(
            "NODE_COMPILE_CACHE",
            user_data.join("node-compile-cache").to_string_lossy().to_string(),
        )
        .current_dir(cli.parent().unwrap_or_else(|| Path::new(".")))
        .stdin(Stdio::null());

    if let Ok(log) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(user_data.join("sidecar.log"))
    {
        if let Ok(stdout_log) = log.try_clone() {
            command.stdout(Stdio::from(stdout_log));
        }
        command.stderr(Stdio::from(log));
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let child = command
        .spawn()
        .map_err(|e| format!("无法启动 sidecar（{}）: {e}", node.display()))?;
    {
        let state = app.state::<AppState>();
        let locked = state.sidecar.lock();
        if let Ok(mut guard) = locked {
            *guard = Some(child);
        }
    }

    // 5. 健康检查
    wait_healthy(port, &pass_key)?;
    config::log_line(
        user_data,
        &format!(
            "sidecar 健康检查通过 ({}ms): http://127.0.0.1:{port}",
            elapsed_ms(app)
        ),
    );
    Ok(())
}

fn elapsed_ms(app: &AppHandle) -> u128 {
    app.try_state::<AppState>()
        .map(|state| state.started_at.elapsed().as_millis())
        .unwrap_or(0)
}

/// 读取 appConfig.json；解析失败时备份并重置为空对象
fn load_app_config(path: &Path) -> serde_json::Value {
    let Ok(text) = std::fs::read_to_string(path) else {
        return json!({});
    };
    match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(_) => {
            let _ = std::fs::rename(path, path.with_extension("json.bak"));
            json!({})
        }
    }
}

fn generate_pass_key() -> String {
    use rand::distributions::Alphanumeric;
    use rand::Rng;
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(16)
        .map(char::from)
        .collect()
}

fn pick_port(start: u16) -> u16 {
    for offset in 0..50u16 {
        let port = start.saturating_add(offset);
        if port == 0 {
            break;
        }
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return port;
        }
    }
    start
}

fn wait_healthy(port: u16, pass_key: &str) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{port}/common/version");
    let deadline = Instant::now() + HEALTH_TIMEOUT;
    let mut last_error = String::from("timeout");
    while Instant::now() < deadline {
        match ureq::get(&url)
            .set("Authorization", pass_key)
            .timeout(Duration::from_secs(2))
            .call()
        {
            Ok(response) if response.status() == 200 => return Ok(()),
            Ok(response) => last_error = format!("status {}", response.status()),
            Err(error) => last_error = error.to_string(),
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(format!(
        "健康检查超时（{url}）：{last_error}，详见 sidecar.log"
    ))
}

fn node_path(app: &AppHandle) -> PathBuf {
    if let Ok(path) = std::env::var("BILILIVE_TAURI_NODE") {
        return PathBuf::from(path);
    }
    if cfg!(debug_assertions) {
        return PathBuf::from("node");
    }
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join(name));
        candidates.push(dir.join("binaries").join(name));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(name));
        }
    }
    candidates
        .into_iter()
        .find(|path| path.exists())
        .map(config::simplify_path)
        .unwrap_or_else(|| PathBuf::from(name))
}

fn cli_entry_path(app: &AppHandle) -> PathBuf {
    if let Ok(path) = std::env::var("BILILIVE_TAURI_CLI") {
        return PathBuf::from(path);
    }
    if cfg!(debug_assertions) {
        return PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../CLI/lib/index.cjs");
    }
    app.path()
        .resource_dir()
        .map(|dir| config::simplify_path(dir.join("cli").join("index.cjs")))
        .unwrap_or_else(|_| PathBuf::from("cli/index.cjs"))
}

/// 外部二进制的候选目录，按优先级排列：
/// 1. 环境变量 `BILILIVE_TAURI_BIN_DIR`（调试/自定义安装）
/// 2. 打包后的 `<resource>/bin`
/// 3. 开发态仓库内的 `packages/app/resources/bin`（与 Electron 版共用 install-bin.js 的产物）
fn bin_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = std::env::var("BILILIVE_TAURI_BIN_DIR") {
        dirs.push(PathBuf::from(dir));
    }
    if let Ok(dir) = app.path().resource_dir() {
        dirs.push(config::simplify_path(dir).join("bin"));
    }
    if cfg!(debug_assertions) {
        dirs.push(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("..")
                .join("app")
                .join("resources")
                .join("bin"),
        );
    }
    dirs
}

/// 外部二进制路径：优先取候选目录中真实存在的文件，都没有时退回文件名（依赖系统 PATH）
fn bin_path(app: &AppHandle, name: &str) -> String {
    let file_name = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    for dir in bin_dirs(app) {
        let candidate = config::simplify_path(dir.join(&file_name));
        if candidate.is_file() {
            return candidate.to_string_lossy().into_owned();
        }
    }
    file_name
}

/// 启动时检测外部二进制是否缺失，缺失时在 tauri.log 中给出明确提示
fn warn_missing_bins(user_data: &Path, cli_config: &serde_json::Value) {
    let keys = [
        "ffmpegPath",
        "ffprobePath",
        "mesioPath",
        "bililiveRecorderPath",
        "audiowaveformPath",
        "danmakuFactoryPath",
    ];
    let missing: Vec<String> = keys
        .iter()
        .filter_map(|key| {
            let path = cli_config.get(*key)?.as_str()?;
            // 相对路径代表「交给系统 PATH 解析」，不做存在性判断
            (Path::new(path).is_absolute() && !Path::new(path).is_file())
                .then(|| format!("{key}={path}"))
        })
        .collect();
    if missing.is_empty() {
        return;
    }
    let message = format!(
        "外部工具缺失（将退回系统 PATH）：{}；开发态请先运行 pnpm run install:bin，或设置 BILILIVE_TAURI_BIN_DIR 指向所在目录",
        missing.join(", ")
    );
    config::log_line(user_data, &message);
    eprintln!("{message}");
}

pub fn stop(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let locked = state.sidecar.lock();
    if let Ok(mut guard) = locked {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
