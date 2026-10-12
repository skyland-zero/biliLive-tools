use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// 与 Electron 版保持一致的用户数据目录（%APPDATA%/biliLive-tools 等）
pub fn user_data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("BILILIVE_USER_DATA") {
        return PathBuf::from(dir);
    }
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("biliLive-tools")
}

pub fn read_json(path: &Path) -> serde_json::Value {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|_| serde_json::json!({})),
        Err(_) => serde_json::json!({}),
    }
}

pub fn write_json(path: &Path, value: &serde_json::Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string(value).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| e.to_string())
}

/// lodash get 风格的点路径读取
pub fn get_by_path(value: &serde_json::Value, key: &str) -> serde_json::Value {
    let mut current = value;
    for part in key.split('.') {
        match current.get(part) {
            Some(next) => current = next,
            None => return serde_json::Value::Null,
        }
    }
    current.clone()
}

/// Windows 下 Tauri 返回的路径可能带 `\\?\` 扩展前缀，
/// node 用它解析入口脚本会报 `EISDIR lstat 'D:'`，这里去掉前缀
pub fn simplify_path(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path
}

pub fn log_line(dir: &Path, message: &str) {
    let line = format!(
        "[{}] {}\n",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        message
    );
    let _ = std::fs::create_dir_all(dir);
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("tauri.log"))
    {
        use std::io::Write;
        let _ = file.write_all(line.as_bytes());
    }
}
