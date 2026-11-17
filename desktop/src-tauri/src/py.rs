use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

/// 选一个能 `import PIL` 的 Python。
///
/// 桌面端原先写死 `python3`：这台机器上 /opt/homebrew/bin/python3 没有 Pillow，
/// dedup 会把 396 张图静默记成 status=error。这里按 LIFELOG_PYTHON → .venv → python3
/// 的顺序挑第一个可用的，挑不到就明确报错，不再继续跑一个注定失败的进程。
pub fn resolve(home: &Path) -> Result<PathBuf, String> {
    static CACHE: Mutex<Option<PathBuf>> = Mutex::new(None);
    if let Ok(guard) = CACHE.lock() {
        if let Some(found) = guard.as_ref() {
            return Ok(found.clone());
        }
    }
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default();
    let script = root.join("scripts").join("resolve_python.py");
    if !script.exists() {
        return Err(format!("找不到解释器解析脚本：{}", script.display()));
    }
    let output = Command::new("python3")
        .arg(&script)
        .env("LIFELOG_HOME", home)
        .output()
        .map_err(|err| format!("启动 Python 解释器探测失败：{err}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() || stdout.is_empty() {
        return Err(if stderr.is_empty() {
            stdout
        } else {
            stderr
        });
    }
    let path = PathBuf::from(&stdout);
    if !path.exists() {
        return Err(format!("解释器不存在：{stdout}"));
    }
    if let Ok(mut guard) = CACHE.lock() {
        *guard = Some(path.clone());
    }
    Ok(path)
}

/// 打印解析结果，供命令行诊断（`--python-report`）。
pub fn report_string(home: &Path) -> String {
    match resolve(home) {
        Ok(path) => serde_json::json!({"ok": true, "python": path.to_string_lossy()}).to_string(),
        Err(err) => serde_json::json!({"ok": false, "error": err}).to_string(),
    }
}

pub fn report(home: &Path) -> serde_json::Value {
    match resolve(home) {
        Ok(path) => serde_json::json!({"ok": true, "python": path.to_string_lossy()}),
        Err(err) => serde_json::json!({"ok": false, "error": err}),
    }
}
