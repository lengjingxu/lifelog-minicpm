use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::Read;
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Owns the Python `lifelog.web` sidecar and proxies the `/api/live/*` routes.
/// The webview never talks HTTP directly: every request goes through a Tauri
/// command so CORS/CSP stay out of the picture.
pub struct LiveSidecar {
    inner: Arc<Inner>,
}

struct Inner {
    home: PathBuf,
    root: PathBuf,
    state: Mutex<SidecarState>,
    start_lock: Mutex<()>,
}

#[derive(Default)]
struct SidecarState {
    child: Option<Child>,
    port: Option<u16>,
    failures: u32,
    next_retry: Option<Instant>,
}

#[derive(Deserialize)]
pub struct LiveStartArgs {
    pub mode: Option<String>,
    pub count: Option<i64>,
    pub concurrency: Option<i64>,
    pub speed: Option<f64>,
}

#[derive(Serialize)]
pub struct LiveCommandError {
    pub code: &'static str,
    pub service: &'static str,
    pub message: String,
}

fn command_error(message: String) -> LiveCommandError {
    LiveCommandError {
        code: "live_unavailable",
        service: "lifelog-live",
        message,
    }
}

impl LiveSidecar {
    pub fn new(home: PathBuf, root: PathBuf) -> Self {
        Self {
            inner: Arc::new(Inner {
                home,
                root,
                state: Mutex::new(SidecarState::default()),
                start_lock: Mutex::new(()),
            }),
        }
    }

    fn ensure_started(&self) -> Result<u16, String> {
        let _start_guard = self
            .inner
            .start_lock
            .lock()
            .map_err(|_| "识别服务状态锁失败".to_string())?;

        if let Some(port) = self.live_port()? {
            return Ok(port);
        }

        {
            let state = self
                .inner
                .state
                .lock()
                .map_err(|_| "识别服务状态锁失败".to_string())?;
            if let Some(next_retry) = state.next_retry {
                let now = Instant::now();
                if next_retry > now {
                    let wait = (next_retry - now).as_secs_f64().ceil() as u64;
                    return Err(format!(
                        "识别服务未启动：上次启动失败，正在退避重试（约 {wait} 秒后）"
                    ));
                }
            }
        }

        let port = free_port()?;
        let code = format!("from lifelog.web import serve; serve({port}, '127.0.0.1')");
        let mut command = Command::new("python3");
        command
            .args(["-c", &code])
            .current_dir(&self.inner.root)
            .env("LIFELOG_HOME", &self.inner.home)
            .env("PYTHONUNBUFFERED", "1")
            .stdout(Stdio::null())
            .stderr(Stdio::piped());

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(err) => {
                self.record_failure();
                return Err(format!(
                    "识别服务未启动：无法运行 python3（{err}）。请确认 Python 已安装并包含 lifelog 依赖。"
                ));
            }
        };

        let deadline = Instant::now() + Duration::from_secs(8);
        let state_url = format!("http://127.0.0.1:{port}/api/live/state");
        loop {
            if let Some(status) = child.try_wait().map_err(|err| err.to_string())? {
                let mut detail = String::new();
                if let Some(mut stderr) = child.stderr.take() {
                    let _ = stderr.read_to_string(&mut detail);
                }
                let detail = detail.trim();
                self.record_failure();
                return Err(if detail.is_empty() {
                    format!("识别服务未启动：python sidecar 已退出（{status}）")
                } else {
                    format!("识别服务未启动：python sidecar 已退出（{status}）：{detail}")
                });
            }

            if probe(&state_url).is_ok() {
                let mut state = self
                    .inner
                    .state
                    .lock()
                    .map_err(|_| "识别服务状态锁失败".to_string())?;
                state.child = Some(child);
                state.port = Some(port);
                state.failures = 0;
                state.next_retry = None;
                return Ok(port);
            }

            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                self.record_failure();
                return Err(format!(
                    "识别服务未启动：8 秒内没有等到 http://127.0.0.1:{port}/api/live/state"
                ));
            }
            std::thread::sleep(Duration::from_millis(160));
        }
    }

    fn live_port(&self) -> Result<Option<u16>, String> {
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| "识别服务状态锁失败".to_string())?;
        let Some(child) = state.child.as_mut() else {
            state.port = None;
            return Ok(None);
        };
        match child.try_wait() {
            Ok(None) => Ok(state.port),
            Ok(Some(_)) => {
                state.child = None;
                state.port = None;
                state.failures = state.failures.saturating_add(1);
                state.next_retry = Some(Instant::now() + backoff(state.failures));
                Ok(None)
            }
            Err(err) => Err(format!("检查识别服务失败：{err}")),
        }
    }

    fn record_failure(&self) {
        if let Ok(mut state) = self.inner.state.lock() {
            state.failures = state.failures.saturating_add(1);
            state.next_retry = Some(Instant::now() + backoff(state.failures));
        }
    }

    fn call(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value, String> {
        let port = self.ensure_started()?;
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(3))
            .build()
            .map_err(|err| format!("创建识别服务请求失败：{err}"))?;
        let url = format!("http://127.0.0.1:{port}{path}");
        let mut request = client.request(method, &url);
        if let Some(payload) = body {
            request = request.json(&payload);
        }
        let response = request
            .send()
            .map_err(|err| format!("识别服务未就绪：{err}"))?;
        let status = response.status();
        let text = response
            .text()
            .map_err(|err| format!("读取识别服务响应失败：{err}"))?;
        match serde_json::from_str::<Value>(&text) {
            Ok(value) => Ok(value),
            Err(_) => Ok(json!({
                "ok": false,
                "error": format!("识别服务返回了非 JSON 响应（HTTP {status}）：{text}")
            })),
        }
    }

    pub fn start(&self, args: LiveStartArgs) -> Result<Value, String> {
        let payload = json!({
            "mode": args.mode.unwrap_or_else(|| "sim".to_string()),
            "count": args.count.unwrap_or(24),
            "concurrency": args.concurrency.unwrap_or(4),
            "speed": args.speed.unwrap_or(2.0),
        });
        self.call(reqwest::Method::POST, "/api/live/start", Some(payload))
    }

    pub fn state(&self) -> Result<Value, String> {
        self.call(reqwest::Method::GET, "/api/live/state", None)
    }

    pub fn events(&self, cursor: i64) -> Result<Value, String> {
        let cursor = cursor.max(0);
        self.call(
            reqwest::Method::GET,
            &format!("/api/live/events?cursor={cursor}"),
            None,
        )
    }

    pub fn stop(&self) -> Result<Value, String> {
        self.call(reqwest::Method::POST, "/api/live/stop", Some(json!({})))
    }

    pub fn photos(&self) -> Result<Value, String> {
        self.call(reqwest::Method::GET, "/api/live/photos", None)
    }

    pub fn health(&self) -> Result<Value, String> {
        let port = self.ensure_started()?;
        let state = self.state()?;
        Ok(json!({
            "ok": true,
            "port": port,
            "label": "Python sidecar · /api/live",
            "state": state,
        }))
    }

    pub fn shutdown(&self) {
        if let Ok(mut state) = self.inner.state.lock() {
            if let Some(mut child) = state.child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
            state.port = None;
        }
    }
}

impl Drop for LiveSidecar {
    fn drop(&mut self) {
        if Arc::strong_count(&self.inner) == 1 {
            if let Ok(mut state) = self.inner.state.lock() {
                if let Some(mut child) = state.child.take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
    }
}

fn free_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|err| format!("识别服务未启动：找不到空闲端口（{err}）"))?;
    let port = listener
        .local_addr()
        .map_err(|err| format!("识别服务未启动：读取端口失败（{err}）"))?
        .port();
    drop(listener);
    Ok(port)
}

fn backoff(failures: u32) -> Duration {
    let seconds = match failures {
        0 | 1 => 1,
        2 => 2,
        3 => 4,
        4 => 8,
        5 => 16,
        _ => 30,
    };
    Duration::from_secs(seconds)
}

fn probe(url: &str) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(700))
        .build()
        .map_err(|err| err.to_string())?;
    client
        .get(url)
        .send()
        .map(|_| ())
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn live_health(sidecar: tauri::State<'_, LiveSidecar>) -> Result<Value, LiveCommandError> {
    let sidecar = sidecar.inner.clone();
    tauri::async_runtime::spawn_blocking(move || LiveSidecar { inner: sidecar }.health())
        .await
        .map_err(|err| command_error(format!("识别服务检查失败：{err}")))?
        .map_err(command_error)
}

#[tauri::command]
pub async fn live_start(
    sidecar: tauri::State<'_, LiveSidecar>,
    args: LiveStartArgs,
) -> Result<Value, LiveCommandError> {
    let sidecar = sidecar.inner.clone();
    tauri::async_runtime::spawn_blocking(move || LiveSidecar { inner: sidecar }.start(args))
        .await
        .map_err(|err| command_error(format!("启动识别服务失败：{err}")))?
        .map_err(command_error)
}

#[tauri::command]
pub async fn live_state(sidecar: tauri::State<'_, LiveSidecar>) -> Result<Value, LiveCommandError> {
    let sidecar = sidecar.inner.clone();
    tauri::async_runtime::spawn_blocking(move || LiveSidecar { inner: sidecar }.state())
        .await
        .map_err(|err| command_error(format!("读取识别进度失败：{err}")))?
        .map_err(command_error)
}

#[tauri::command]
pub async fn live_events(
    sidecar: tauri::State<'_, LiveSidecar>,
    cursor: i64,
) -> Result<Value, LiveCommandError> {
    let sidecar = sidecar.inner.clone();
    tauri::async_runtime::spawn_blocking(move || LiveSidecar { inner: sidecar }.events(cursor))
        .await
        .map_err(|err| command_error(format!("读取识别事件失败：{err}")))?
        .map_err(command_error)
}

#[tauri::command]
pub async fn live_stop(sidecar: tauri::State<'_, LiveSidecar>) -> Result<Value, LiveCommandError> {
    let sidecar = sidecar.inner.clone();
    tauri::async_runtime::spawn_blocking(move || LiveSidecar { inner: sidecar }.stop())
        .await
        .map_err(|err| command_error(format!("暂停识别失败：{err}")))?
        .map_err(command_error)
}

#[tauri::command]
pub async fn live_photos(sidecar: tauri::State<'_, LiveSidecar>) -> Result<Value, LiveCommandError> {
    let sidecar = sidecar.inner.clone();
    tauri::async_runtime::spawn_blocking(move || LiveSidecar { inner: sidecar }.photos())
        .await
        .map_err(|err| command_error(format!("读取识别队列失败：{err}")))?
        .map_err(command_error)
}
