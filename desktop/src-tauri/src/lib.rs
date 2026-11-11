use rusqlite::{params_from_iter, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Manager, State};

mod live;

use live::LiveSidecar;

struct Db {
    path: PathBuf,
    data_dir: PathBuf,
    conn: Mutex<Option<Connection>>,
}

fn resolve_data_dir() -> PathBuf {
    if let Ok(home) = std::env::var("LIFELOG_HOME") {
        return PathBuf::from(home);
    }
    let fallback = dirs::home_dir()
        .unwrap_or_default()
        .join("dev/lifelog-minicpm/data");
    fallback
}

fn desktop_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default())
}

fn repo_root() -> PathBuf {
    desktop_root()
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(desktop_root)
}

fn directory_usage(path: &Path, extensions: Option<&[&str]>) -> (u64, u64) {
    let mut bytes = 0u64;
    let mut files = 0u64;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if let Ok(meta) = entry.metadata() {
                let matches = extensions.is_none_or(|wanted| {
                    path.extension()
                        .and_then(|ext| ext.to_str())
                        .is_some_and(|ext| wanted.iter().any(|item| item.eq_ignore_ascii_case(ext)))
                });
                if matches {
                    bytes += meta.len();
                    files += 1;
                }
            }
        }
    }
    (bytes, files)
}

impl Db {
    fn open(&self) -> Result<std::sync::MutexGuard<'_, Option<Connection>>, String> {
        let mut guard = self.conn.lock().map_err(|e| e.to_string())?;
        if guard.is_none() {
            let conn = Connection::open_with_flags(
                &self.path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
            )
            .map_err(|e| format!("打开数据库失败: {e}"))?;
            conn.busy_timeout(std::time::Duration::from_millis(1500)).ok();
            *guard = Some(conn);
        }
        Ok(guard)
    }

    fn thumb_path(&self, id: &str) -> String {
        let p = self.data_dir.join("thumbs").join(format!("{id}.jpg"));
        p.to_string_lossy().to_string()
    }

    fn full_path(&self, id: &str, original: &str) -> String {
        let full = self.data_dir.join("thumbs").join("full").join(format!("{id}.jpg"));
        if full.exists() {
            return full.to_string_lossy().to_string();
        }
        let path = Path::new(original);
        if path.is_absolute() {
            original.to_string()
        } else {
            self.data_dir.join(path).to_string_lossy().to_string()
        }
    }
}

#[derive(Serialize, Clone)]
struct AssetRow {
    id: String,
    path: String,
    thumb: String,
    original: String,
    day: Option<String>,
    taken_at: Option<String>,
    kind: Option<String>,
    caption: Option<String>,
    scene: Option<String>,
    people: Option<String>,
    place: Option<String>,
    activity: Option<String>,
    mood: Option<String>,
    tags: Vec<String>,
    ocr_text: Option<String>,
}

#[derive(Deserialize, Default)]
struct Filter {
    query: Option<String>,
    tag: Option<String>,
    scene: Option<String>,
    kind: Option<String>,
    day_from: Option<String>,
    day_to: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
}

#[derive(Serialize)]
struct Stats {
    assets: i64,
    captions: i64,
    days: i64,
    events: i64,
    first_day: Option<String>,
    last_day: Option<String>,
    db_path: String,
    db_size: u64,
}

#[derive(Serialize, Default)]
struct Facets {
    tags: Vec<(String, i64)>,
    scenes: Vec<(String, i64)>,
    people: Vec<(String, i64)>,
    months: Vec<(String, i64)>,
}

fn parse_tags(raw: Option<String>) -> Vec<String> {
    match raw {
        Some(text) => serde_json::from_str::<Vec<String>>(&text).unwrap_or_default(),
        None => Vec::new(),
    }
}

#[tauri::command]
fn library_stats(db: State<'_, Db>) -> Result<Stats, String> {
    let guard = db.open()?;
    let conn = guard.as_ref().unwrap();
    let count = |table: &str| -> i64 {
        conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .unwrap_or(0)
    };
    let first: Option<String> = conn
        .query_row("SELECT min(day) FROM assets WHERE day IS NOT NULL", [], |r| r.get(0))
        .unwrap_or(None);
    let last: Option<String> = conn
        .query_row("SELECT max(day) FROM assets WHERE day IS NOT NULL", [], |r| r.get(0))
        .unwrap_or(None);
    Ok(Stats {
        assets: count("assets"),
        captions: count("captions"),
        days: count("days"),
        events: count("events"),
        first_day: first,
        last_day: last,
        db_path: db.path.to_string_lossy().to_string(),
        db_size: std::fs::metadata(&db.path).map(|meta| meta.len()).unwrap_or(0),
    })
}

#[tauri::command]
fn query_assets(db: State<'_, Db>, filter: Filter) -> Result<Vec<AssetRow>, String> {
    let guard = db.open()?;
    let conn = guard.as_ref().unwrap();
    let mut sql = String::from(
        "SELECT a.id, a.path, a.day, a.taken_at, a.kind,
                c.caption, c.scene, c.people, c.place, c.activity, c.mood, c.tags, c.ocr_text
         FROM assets a
         LEFT JOIN captions c ON c.rowid = (
             SELECT rowid FROM captions c2 WHERE c2.asset_id = a.id ORDER BY c2.created_at DESC LIMIT 1)
         WHERE 1=1",
    );
    let mut args: Vec<rusqlite::types::Value> = Vec::new();

    if let Some(q) = filter.query.as_deref().map(str::trim).filter(|q| !q.is_empty()) {
        sql.push_str(
            " AND (c.caption LIKE ?1 OR c.tags LIKE ?1 OR c.scene LIKE ?1 OR c.ocr_text LIKE ?1 OR c.place LIKE ?1 OR a.path LIKE ?1)",
        );
        args.push(rusqlite::types::Value::Text(format!("%{q}%")));
    }
    let next_index = |sql: &mut String, args: &mut Vec<rusqlite::types::Value>, value: Option<&str>, clause: &str| {
        if let Some(v) = value.filter(|v| !v.is_empty()) {
            args.push(rusqlite::types::Value::Text(v.to_string()));
            sql.push_str(&clause.replace("{n}", &args.len().to_string()));
        }
    };
    next_index(&mut sql, &mut args, filter.tag.as_deref(), " AND c.tags LIKE '%' || ?{n} || '%'");
    next_index(&mut sql, &mut args, filter.scene.as_deref(), " AND c.scene = ?{n}");
    next_index(&mut sql, &mut args, filter.kind.as_deref(), " AND a.kind = ?{n}");
    next_index(&mut sql, &mut args, filter.day_from.as_deref(), " AND a.day >= ?{n}");
    next_index(&mut sql, &mut args, filter.day_to.as_deref(), " AND a.day <= ?{n}");

    sql.push_str(" ORDER BY a.taken_at DESC, a.day DESC LIMIT ?");
    args.push(rusqlite::types::Value::Integer(filter.limit.unwrap_or(500)));
    sql.push_str(" OFFSET ?");
    args.push(rusqlite::types::Value::Integer(filter.offset.unwrap_or(0)));

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params_from_iter(args.iter()), |row| {
            let id: String = row.get(0)?;
            let path: String = row.get(1)?;
            Ok(AssetRow {
                thumb: String::new(),
                original: path.clone(),
                path,
                id,
                day: row.get(2)?,
                taken_at: row.get(3)?,
                kind: row.get(4)?,
                caption: row.get(5)?,
                scene: row.get(6)?,
                people: row.get(7)?,
                place: row.get(8)?,
                activity: row.get(9)?,
                mood: row.get(10)?,
                tags: parse_tags(row.get(11)?),
                ocr_text: row.get(12)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    for row in rows {
        let mut asset = row.map_err(|e| e.to_string())?;
        asset.thumb = db.thumb_path(&asset.id);
        asset.original = db.full_path(&asset.id, &asset.path);
        out.push(asset);
    }
    Ok(out)
}

#[tauri::command]
fn facets(db: State<'_, Db>) -> Result<Facets, String> {
    let guard = db.open()?;
    let conn = guard.as_ref().unwrap();
    let mut facets = Facets::default();

    let mut stmt = conn
        .prepare("SELECT tags, scene, people FROM captions")
        .map_err(|e| e.to_string())?;
    let mut tags: HashMap<String, i64> = HashMap::new();
    let mut scenes: HashMap<String, i64> = HashMap::new();
    let mut people: HashMap<String, i64> = HashMap::new();
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    for row in rows.flatten() {
        for tag in parse_tags(row.0) {
            *tags.entry(tag).or_insert(0) += 1;
        }
        if let Some(scene) = row.1.filter(|s| !s.is_empty()) {
            *scenes.entry(scene).or_insert(0) += 1;
        }
        if let Some(person) = row.2.filter(|p| !p.is_empty()) {
            *people.entry(person).or_insert(0) += 1;
        }
    }
    let sorted = |map: HashMap<String, i64>| {
        let mut v: Vec<(String, i64)> = map.into_iter().collect();
        v.sort_by(|a, b| b.1.cmp(&a.1));
        v
    };
    facets.tags = sorted(tags);
    facets.scenes = sorted(scenes);
    facets.people = sorted(people);

    let mut stmt = conn
        .prepare("SELECT substr(day,1,7) AS m, count(*) FROM assets WHERE day IS NOT NULL GROUP BY m ORDER BY m DESC")
        .map_err(|e| e.to_string())?;
    let months = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))
        .map_err(|e| e.to_string())?
        .flatten()
        .collect();
    facets.months = months;
    Ok(facets)
}

#[tauri::command]
fn health(db: State<'_, Db>) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "data_dir": db.data_dir.to_string_lossy(),
        "db_exists": Path::new(&db.path).exists(),
    }))
}

#[tauri::command]
async fn app_settings(db: State<'_, Db>) -> Result<serde_json::Value, String> {
    let data_dir = db.data_dir.clone();
    let db_path = db.path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let db_size = std::fs::metadata(&db_path).map(|meta| meta.len()).unwrap_or(0);
        let (data_bytes, data_files) = directory_usage(&data_dir, None);
        let (thumb_bytes, thumb_files) = directory_usage(&data_dir.join("thumbs"), Some(&["jpg", "jpeg"]));
        let home = dirs::home_dir().unwrap_or_default();
        let token_dir = home.join(".xiaomi-token");
        let token_file = token_dir.join("token.mjs");
        let model_key = std::env::var("LIFELOG_MODEL").unwrap_or_else(|_| "minicpm-v-4.7-1b".to_string());
        let model_title = match model_key.as_str() {
            "minicpm-v-4.5-8b" => "MiniCPM-V-4.5-8B",
            "minicpm-ocr-1.0" => "MiniCPM-OCR-1.0",
            "minicpm-ocr-jev" => "MiniCPM-OCR-Jev",
            _ => "MiniCPM-V-4.7-1B",
        };
        let models_dir = PathBuf::from(
            std::env::var("LIFELOG_MODELS_DIR").unwrap_or_else(|_| "/Volumes/Leng/Models".to_string()),
        );
        Ok(serde_json::json!({
            "data_dir": data_dir.to_string_lossy(),
            "db_path": db_path.to_string_lossy(),
            "db_size": db_size,
            "data_size": data_bytes,
            "data_files": data_files,
            "thumb_cache": {
                "path": data_dir.join("thumbs").to_string_lossy(),
                "size": thumb_bytes,
                "count": thumb_files,
            },
            "model": {
                "key": model_key,
                "title": model_title,
                "path": models_dir.join(model_key.clone()).to_string_lossy(),
                "available": models_dir.join(model_key).exists(),
                "role": "全库识别 · 端侧 MiniCPM",
            },
            "xiaomi": {
                "logged_in": token_file.exists() || token_dir.exists(),
                "token_dir": token_dir.to_string_lossy(),
                "detail": if token_file.exists() { "检测到 ~/.xiaomi-token/token.mjs" } else { "未检测到登录态文件" },
            },
            "read_only": true,
        }))
    })
    .await
    .map_err(|err| format!("读取设置失败：{err}"))?
}

#[tauri::command]
async fn rebuild_thumbs(db: State<'_, Db>) -> Result<serde_json::Value, String> {
    let home = db.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = desktop_root();
        let script = root.join("scripts/gen_thumbs.py");
        if !script.exists() {
            return Err(format!("找不到缩略图脚本：{}", script.display()));
        }
        let output = std::process::Command::new("python3")
            .arg(&script)
            .arg("--force")
            .current_dir(&root)
            .env("LIFELOG_HOME", &home)
            .output()
            .map_err(|err| format!("启动缩略图重建失败：{err}"))?;
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let tail = |text: &str| -> String {
            let trimmed = text.trim();
            let chars: Vec<char> = trimmed.chars().collect();
            chars[chars.len().saturating_sub(1600)..].iter().collect()
        };
        Ok(serde_json::json!({
            "ok": output.status.success(),
            "code": output.status.code(),
            "stdout": tail(&stdout),
            "stderr": tail(&stderr),
        }))
    })
    .await
    .map_err(|err| format!("重建缩略图失败：{err}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let data_dir = resolve_data_dir();
    let db_path = std::env::var("LIFELOG_DB")
        .map(PathBuf::from)
        .unwrap_or_else(|_| data_dir.join("lifelog.sqlite"));

    let sidecar = LiveSidecar::new(data_dir.clone(), repo_root());

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(Db {
            path: db_path,
            data_dir,
            conn: Mutex::new(None),
        })
        .manage(sidecar)
        .invoke_handler(tauri::generate_handler![
            library_stats,
            query_assets,
            facets,
            health,
            app_settings,
            rebuild_thumbs,
            live::live_health,
            live::live_start,
            live::live_state,
            live::live_events,
            live::live_stop,
            live::live_photos
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            app_handle.state::<LiveSidecar>().shutdown();
        }
    });
}
