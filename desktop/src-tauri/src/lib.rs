use rusqlite::{params_from_iter, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::io::{BufRead, BufReader, Read};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter, Manager, State};

mod export;

mod py;

mod live;

use live::LiveSidecar;

struct Db {
    path: PathBuf,
    data_dir: PathBuf,
    conn: Mutex<Option<Connection>>,
}

/// 在后台线程里临时打开库（不经过 State 的连接锁），用完就关。
fn open_conn(dir: &Path) -> Result<Connection, String> {
    Connection::open_with_flags(
        dir.join("lifelog.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_CREATE,
    )
    .map_err(|err| err.to_string())
}

// ---------- 照片库位置：配置文件 + 首次启动引导 ----------

const LIBRARY_CONFIG_NAME: &str = "library.json";

fn app_config_dir() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_default();
    home.join("Library/Application Support/com.leng.shiguang")
}

fn library_config_path() -> PathBuf {
    app_config_dir().join(LIBRARY_CONFIG_NAME)
}

fn read_library_config() -> Option<PathBuf> {
    let raw = std::fs::read_to_string(library_config_path()).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let dir = value.get("data_dir")?.as_str()?.trim();
    if dir.is_empty() {
        None
    } else {
        Some(PathBuf::from(dir))
    }
}

fn write_library_config(dir: &Path) -> Result<(), String> {
    let path = library_config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body = serde_json::json!({ "data_dir": dir.to_string_lossy() });
    std::fs::write(&path, format!("{}\n", body)).map_err(|e| e.to_string())
}

/// 库是否可用：目录存在且里面有 lifelog.sqlite。
fn library_ready(dir: &Path) -> bool {
    dir.is_dir() && dir.join("lifelog.sqlite").is_file()
}

/// 解析顺序：LIFELOG_HOME → 配置文件 → 默认路径（存在才用）→ 需要首次启动引导。
fn resolve_data_dir() -> PathBuf {
    if let Ok(home) = std::env::var("LIFELOG_HOME") {
        return PathBuf::from(home);
    }
    if let Some(dir) = read_library_config() {
        return dir;
    }
    let fallback = dirs::home_dir()
        .unwrap_or_default()
        .join("dev/lifelog-minicpm/data");
    if library_ready(&fallback) {
        return fallback;
    }
    fallback
}

/// 启动时是否需要引导用户选库。
fn needs_library_setup(dir: &Path) -> bool {
    // 真实库被删/挪走时也要回到引导页，否则打开就是一个空库而且还不能换。
    !library_ready(dir)
}

fn ensure_library_layout(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("创建目录失败：{e}"))?;
    for child in ["thumbs", "thumbs/full"] {
        std::fs::create_dir_all(dir.join(child)).map_err(|e| format!("创建目录失败：{e}"))?;
    }
    Ok(())
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
    /// 用户手动收藏（asset_favorite 里有行）。
    favorite: bool,
    /// 美学分（0-10）。库里没有 asset_quality 表时为 None。
    score: Option<f64>,
    /// 文件字节数
    size: Option<i64>,
    /// 同 size + 同 kind 的图片组：组内文件数（≥2 才有值）。
    dup_count: Option<i64>,
    /// 仅重复图：这张是否是所在组的 keeper（保留那张）。
    keeper: Option<bool>,
}

#[derive(Deserialize, Default)]
struct Filter {
    query: Option<String>,
    tag: Option<String>,
    album: Option<String>,
    scene: Option<String>,
    person: Option<String>,
    place: Option<String>,
    kind: Option<String>,
    day_from: Option<String>,
    day_to: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
    /// 深翻页游标：`taken_at|day|id`，取上一页最后一条。给了游标就忽略 offset。
    cursor: Option<String>,
    /// 排序：taken_desc（默认）/ taken_asc / size_desc / size_asc。
    /// 按大小排时不走时间游标，退回 offset 分页。
    sort: Option<String>,
    /// 图库清理视角：large（默认，按大小）/ dup（同 size 同 kind）/ screenshot / video / photo。
    view: Option<String>,
    /// 只看收藏。true 时 JOIN asset_favorite（走主键，不扫表）。
    favorite: Option<bool>,
}

#[derive(Serialize)]
struct MonthRow {
    month: String,
    count: i64,
    cover_id: String,
    cover_thumb: String,
}

/// 时间线的月份摘要：10 万条也只有几百行，前端先渲染月份，展开某个月再按 day_from/day_to 分页取照片。
#[tauri::command]
fn timeline_months(db: State<'_, Db>) -> Result<Vec<MonthRow>, String> {
    let guard = db.open()?;
    let conn = guard.as_ref().unwrap();
    // 月份封面取这个月美学分最高的一张；没有评分表就退回最新一张。
    let cover_order = if has_table(conn, "asset_quality") {
        "ORDER BY COALESCE((SELECT q.score FROM asset_quality q WHERE q.asset_id = a2.id), -1) DESC, a2.taken_at DESC, a2.id DESC"
    } else {
        "ORDER BY a2.taken_at DESC, a2.id DESC"
    };
    let sql = format!(
        "WITH months AS (                  SELECT substr(day, 1, 7) AS m, count(*) AS n FROM assets WHERE deleted_at IS NULL AND day IS NOT NULL GROUP BY m)              SELECT m, n, (                  SELECT a2.id FROM assets a2 WHERE a2.deleted_at IS NULL AND a2.day >= m || '-01'                    AND a2.day < date(m || '-01', '+1 month')                  {} LIMIT 1) AS cover              FROM months ORDER BY m DESC",
        cover_order
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(MonthRow {
                month: row.get(0)?,
                count: row.get(1)?,
                cover_id: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                cover_thumb: String::new(),
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out: Vec<MonthRow> = rows.flatten().collect();
    for item in out.iter_mut() {
        item.cover_thumb = db.thumb_path(&item.cover_id);
    }
    Ok(out)
}

#[derive(Serialize)]
struct GroupRow {
    name: String,
    count: i64,
    cover_id: String,
    cover_thumb: String,
}

fn split_names(value: Option<String>, kind: &str) -> Vec<String> {
    let Some(raw) = value else { return Vec::new() };
    let cleaned = raw.trim().to_string();
    if cleaned.is_empty() || cleaned == "无" || cleaned == "未知" {
        return Vec::new();
    }
    let mut out: Vec<String> = Vec::new();
    for part in cleaned.split(['、', '，', ',', ';', '；', '/']) {
        let name = part.trim();
        if name.is_empty() || name == "无" || name == "未知" {
            continue;
        }
        if kind == "people" && name == "没有" {
            continue;
        }
        if !out.iter().any(|n| n == name) {
            out.push(name.to_string());
        }
    }
    out
}

/// 分类页的分组：只返回 name/count/cover，不把 10 万行发给前端。
/// 顺序按 taken_at 倒序，保证每个分组第一次出现的就是最新那张，用它当封面。
#[tauri::command]
fn category_groups(db: State<'_, Db>, kind: String) -> Result<Vec<GroupRow>, String> {
    let guard = db.open()?;
    let conn = guard.as_ref().unwrap();
    // 分类卡的封面 = 该分类里美学分最高的一张（第一次出现的成员即封面）。
    let (score_join, order_by) = if has_table(conn, "asset_quality") {
        (
            " LEFT JOIN asset_quality q ON q.asset_id = a.id",
            "ORDER BY COALESCE(q.score, -1) DESC, a.taken_at DESC, a.id DESC",
        )
    } else {
        ("", "ORDER BY a.taken_at DESC, a.id DESC")
    };
    let sql = format!(
        "SELECT a.id, c.tags, c.scene, c.people, c.place FROM assets a \
         LEFT JOIN captions c ON c.rowid = ( \
             SELECT rowid FROM captions c2 WHERE c2.asset_id = a.id ORDER BY c2.created_at DESC LIMIT 1){} \
         WHERE a.deleted_at IS NULL {}",
        score_join, order_by
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mut order: Vec<String> = Vec::new();
    let mut counts: std::collections::HashMap<String, (i64, String)> = std::collections::HashMap::new();
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    for row in rows.flatten() {
        let (id, tags, scene, people, place) = row;
        let names = match kind.as_str() {
            "tags" => tags
                .as_deref()
                .and_then(|t| serde_json::from_str::<Vec<String>>(t).ok())
                .unwrap_or_default(),
            "scenes" => split_names(scene, "scenes"),
            "people" => split_names(people, "people"),
            _ => split_names(place, "places"),
        };
        for name in names {
            match counts.get_mut(&name) {
                Some(entry) => entry.0 += 1,
                None => {
                    order.push(name.clone());
                    counts.insert(name, (1, id.clone()));
                }
            }
        }
    }

    let mut out: Vec<GroupRow> = order
        .into_iter()
        .map(|name| {
            let (count, cover_id) = counts.get(&name).cloned().unwrap_or((0, String::new()));
            GroupRow { name, count, cover_id, cover_thumb: String::new() }
        })
        .collect();
    for item in out.iter_mut() {
        item.cover_thumb = db.thumb_path(&item.cover_id);
    }
    out.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}

#[derive(Serialize)]
struct Stats {
    assets: i64,
    /// 最近删除里的张数（侧栏入口角标）。
    trash: i64,
    /// 收藏张数（侧栏入口角标）。
    favorite: i64,
    captions: i64,
    days: i64,
    events: i64,
    first_day: Option<String>,
    last_day: Option<String>,
    db_path: String,
    db_size: u64,
}

#[derive(Serialize)]
struct DupMember {
    asset_id: String,
    distance: Option<i64>,
}

#[derive(Serialize)]
struct DupGroup {
    id: i64,
    keeper_id: String,
    reason: String,
    count: i64,
    members: Vec<DupMember>,
}

/// 只读：把去重分组整组读出来。老库没有去重表时返回空数组，不报错。
fn read_dup_groups(conn: &Connection) -> Result<Vec<DupGroup>, String> {
    if !has_table(conn, "dup_groups") || !has_table(conn, "dup_members") {
        return Ok(Vec::new());
    }
    let mut stmt = conn
        .prepare(
            "SELECT g.id, g.keeper_id, g.reason, m.asset_id, m.distance \
             FROM dup_groups g JOIN dup_members m ON m.group_id = g.id \
             JOIN assets a ON a.id = m.asset_id AND a.deleted_at IS NULL \
             ORDER BY g.id, m.distance IS NULL, m.distance, m.asset_id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                row.get::<_, String>(3)?,
                row.get::<_, Option<i64>>(4)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut out: Vec<DupGroup> = Vec::new();
    for row in rows {
        let (id, keeper_id, reason, asset_id, distance) = row.map_err(|e| e.to_string())?;
        if out.last().map(|group| group.id) != Some(id) {
            out.push(DupGroup { id, keeper_id, reason, count: 0, members: Vec::new() });
        }
        let group = out.last_mut().unwrap();
        group.members.push(DupMember { asset_id, distance });
        group.count += 1;
    }
    Ok(out)
}

#[tauri::command]
fn dup_groups(db: State<'_, Db>) -> Result<Vec<DupGroup>, String> {
    let guard = db.open()?;
    let conn = guard.as_ref().unwrap();
    read_dup_groups(conn)
}

#[derive(Serialize, Default)]
struct Facets {
    tags: Vec<(String, i64)>,
    user_tags: Vec<(String, i64)>,
    albums: Vec<(String, i64)>,
    scenes: Vec<(String, i64)>,
    people: Vec<(String, i64)>,
    places: Vec<(String, i64)>,
    months: Vec<(String, i64)>,
}

fn parse_tags(raw: Option<String>) -> Vec<String> {
    match raw {
        Some(text) => serde_json::from_str::<Vec<String>>(&text).unwrap_or_default(),
        None => Vec::new(),
    }
}

// ---------- 换库 / 建库 ----------

#[derive(Serialize)]
struct LibraryState {
    data_dir: String,
    db_path: String,
    ready: bool,
    needs_setup: bool,
    first_launch: bool,
}

fn library_state_of(dir: &Path) -> LibraryState {
    LibraryState {
        data_dir: dir.to_string_lossy().to_string(),
        db_path: dir.join("lifelog.sqlite").to_string_lossy().to_string(),
        ready: library_ready(dir),
        needs_setup: needs_library_setup(dir),
        first_launch: read_library_config().is_none() && !library_ready(dir),
    }
}

#[tauri::command]
fn library_state(db: State<'_, Db>) -> LibraryState {
    library_state_of(&db.data_dir)
}

fn init_library_at(dir: &Path) -> Result<(), String> {
    ensure_library_layout(dir)?;
    let output = std::process::Command::new(py::resolve(dir)?)
        .arg("-c")
        .arg("from lifelog import db; db.init_db()")
        .current_dir(repo_root())
        .env("LIFELOG_HOME", dir)
        .env("PYTHONPATH", repo_root())
        .output()
        .map_err(|e| format!("初始化数据库失败：{e}"))?;
    if !output.status.success() {
        return Err(format!(
            "初始化数据库失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    if !library_ready(dir) {
        return Err("初始化后仍没有找到 lifelog.sqlite".to_string());
    }
    Ok(())
}

/// 选一个已有库：必须是包含 lifelog.sqlite 的目录，否则明确报错。
#[tauri::command]
fn use_library(dir: String) -> Result<LibraryState, String> {
    let trimmed = dir.trim();
    if trimmed.is_empty() {
        return Err("没有选择目录".to_string());
    }
    let path = PathBuf::from(trimmed);
    if !path.is_dir() {
        return Err(format!("目录不存在：{trimmed}"));
    }
    if !path.join("lifelog.sqlite").is_file() {
        return Err("这个文件夹里没有 lifelog.sqlite，请选择拾光的数据目录".to_string());
    }
    write_library_config(&path)?;
    Ok(library_state_of(&path))
}

/// 新建库：空目录（或不存在）里初始化 schema 与目录结构。
#[tauri::command]
fn create_library(dir: String) -> Result<LibraryState, String> {
    let trimmed = dir.trim();
    if trimmed.is_empty() {
        return Err("没有选择目录".to_string());
    }
    let path = PathBuf::from(trimmed);
    if path.exists() {
        if !path.is_dir() {
            return Err(format!("这里不是文件夹：{trimmed}"));
        }
        let mut entries = std::fs::read_dir(&path)
            .map_err(|e| format!("读取目录失败：{e}"))?;
        if entries.next().is_some() {
            return Err("这个文件夹不是空的。请选择空文件夹，或改用「选择已有库」".to_string());
        }
    }
    init_library_at(&path)?;
    write_library_config(&path)?;
    Ok(library_state_of(&path))
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
        .query_row(
            "SELECT min(day) FROM assets WHERE deleted_at IS NULL AND day IS NOT NULL",
            [],
            |r| r.get(0),
        )
        .unwrap_or(None);
    let last: Option<String> = conn
        .query_row(
            "SELECT max(day) FROM assets WHERE deleted_at IS NULL AND day IS NOT NULL",
            [],
            |r| r.get(0),
        )
        .unwrap_or(None);
    Ok(Stats {
        assets: conn
            .query_row("SELECT count(*) FROM assets WHERE deleted_at IS NULL", [], |r| r.get(0))
            .unwrap_or(0),
        trash: conn
            .query_row("SELECT count(*) FROM assets WHERE deleted_at IS NOT NULL", [], |r| r.get(0))
            .unwrap_or(0),
        favorite: conn
            .query_row(
                "SELECT count(*) FROM asset_favorite f JOIN assets a ON a.id = f.asset_id \
                 AND a.deleted_at IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0),
        captions: count("captions"),
        days: count("days"),
        events: count("events"),
        first_day: first,
        last_day: last,
        db_path: db.path.to_string_lossy().to_string(),
        db_size: std::fs::metadata(&db.path).map(|meta| meta.len()).unwrap_or(0),
    })
}

fn has_column(conn: &rusqlite::Connection, table: &str, column: &str) -> bool {
    // table_info 不返回 VIRTUAL 生成列，这里必须用 table_xinfo
    conn.prepare(&format!("PRAGMA table_xinfo({table})"))
        .and_then(|mut stmt| {
            let names: Vec<String> = stmt
                .query_map([], |row| row.get::<_, String>(1))?
                .flatten()
                .collect();
            Ok(names.iter().any(|n| n == column))
        })
        .unwrap_or(false)
}

fn has_table(conn: &rusqlite::Connection, name: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1",
        [name],
        |_| Ok(()),
    )
    .is_ok()
}

fn filter_where(
    filter: &Filter,
    has_asset_tags: bool,
    has_dup_tables: bool,
) -> (String, Vec<rusqlite::types::Value>) {
    // 最近删除里的照片对主库所有查询都不可见（视图 = 未软删）。
    let mut sql = String::from(" WHERE a.deleted_at IS NULL");
    let mut args: Vec<rusqlite::types::Value> = Vec::new();

    if let Some(q) = filter.query.as_deref().map(str::trim).filter(|q| !q.is_empty()) {
        sql.push_str(
            " AND (c.caption LIKE ?1 OR c.tags LIKE ?1 OR c.scene LIKE ?1 OR c.ocr_text LIKE ?1 OR c.place LIKE ?1 OR a.path LIKE ?1)",
        );
        args.push(rusqlite::types::Value::Text(format!("%{q}%")));
    }

    let push = |value: Option<&str>, clause: &str, args: &mut Vec<rusqlite::types::Value>, sql: &mut String| {
        if let Some(v) = value.filter(|v| !v.is_empty()) {
            args.push(rusqlite::types::Value::Text(v.to_string()));
            sql.push_str(&clause.replace("{n}", &args.len().to_string()));
        }
    };

    if let Some(tag) = filter.tag.as_deref().filter(|value| !value.is_empty()) {
        args.push(rusqlite::types::Value::Text(tag.to_string()));
        let index = args.len();
        // 精确匹配：json_each 逐项比较，避免「户外」命中「运动户外」；json_valid 守住脏数据。
        // asset_tags 可能尚未创建（全新库），此时只走 AI 标签分支。
        let mut clause = format!(
            " AND ((json_valid(c.tags) AND EXISTS (SELECT 1 FROM json_each(c.tags) WHERE json_each.value = ?{index}))"
        );
        if has_asset_tags {
            clause.push_str(&format!(
                " OR EXISTS (SELECT 1 FROM asset_tags ut WHERE ut.asset_id = a.id AND ut.tag = ?{index})"
            ));
        }
        clause.push_str(")");
        sql.push_str(&clause);
    }

    push(filter.album.as_deref(), " AND EXISTS (SELECT 1 FROM album_assets aa JOIN albums al ON al.id = aa.album_id WHERE aa.asset_id = a.id AND al.name = ?{n})", &mut args, &mut sql);
    push(filter.scene.as_deref(), " AND c.scene = ?{n}", &mut args, &mut sql);
    push(filter.person.as_deref(), " AND c.people LIKE '%' || ?{n} || '%'", &mut args, &mut sql);
    push(filter.place.as_deref(), " AND c.place LIKE '%' || ?{n} || '%'", &mut args, &mut sql);
    push(filter.kind.as_deref(), " AND a.kind = ?{n}", &mut args, &mut sql);
    if filter.favorite == Some(true) {
        sql.push_str(
            " AND EXISTS (SELECT 1 FROM asset_favorite f WHERE f.asset_id = a.id)",
        );
    }
    push(filter.day_from.as_deref(), " AND a.day >= ?{n}", &mut args, &mut sql);
    push(filter.day_to.as_deref(), " AND a.day <= ?{n}", &mut args, &mut sql);

    // 图库清理视角：都在服务端筛，前端只拿当前这一页。
    // 重复图读真实去重表（dhash 跑完后由 lifelog dedup --build 写入）。
    match filter.view.as_deref() {
        Some("dup") => {
            // 真实去重表：只列 dup_members 里的成员；keeper 也列出来（标「保留」），但不进待清理。
            if has_dup_tables {
                sql.push_str(
                    " AND a.id IN (SELECT asset_id FROM dup_members)",
                );
            } else {
                // 还没跑 dhash：不拿「同 size」冒充重复，前端会显示「正在计算指纹」。
                sql.push_str(" AND 0");
            }
        }
        Some("screenshot") => sql.push_str(
            " AND ((a.path LIKE '%Screenshot%' OR a.path LIKE '%screenshot%'                     OR a.path LIKE '%截屏%' OR a.path LIKE '%屏幕%')                    OR c.scene LIKE '%屏幕%' OR c.scene LIKE '%截屏%'                    OR c.tags LIKE '%屏幕截图%' OR c.tags LIKE '%截屏%')",
        ),
        Some("video") => sql.push_str(" AND a.kind = 'video'"),
        Some("photo") => sql.push_str(" AND (a.kind IS NULL OR a.kind != 'video')"),
        _ => {}
    }

    (sql, args)
}

#[tauri::command]
fn count_assets(db: State<'_, Db>, filter: Filter) -> Result<i64, String> {
    let guard = db.open()?;
    let conn = guard.as_ref().unwrap();
    let has_dup = has_table(conn, "dup_groups") && has_table(conn, "dup_members");
    let (where_sql, args) = filter_where(&filter, has_table(conn, "asset_tags"), has_dup);
    let sql = format!(
        "SELECT count(*) FROM assets a \
         LEFT JOIN captions c ON c.rowid = ( \
             SELECT rowid FROM captions c2 WHERE c2.asset_id = a.id ORDER BY c2.created_at DESC LIMIT 1) \
         {}",
        where_sql
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let total: i64 = stmt
        .query_row(params_from_iter(args.iter()), |row| row.get(0))
        .map_err(|e| e.to_string())?;
    Ok(total)
}

/// 排序计划：是否要 JOIN 评分表、是否退回 offset 分页。
/// 抽成纯函数是为了让「没有 asset_quality 的库」也能被单测覆盖。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SortPlan {
    uses_score: bool,
    offset_paging: bool,
    join: &'static str,
}

const QUALITY_JOIN: &str = " LEFT JOIN asset_quality q ON q.asset_id = a.id";

fn sort_plan(sort: &str, has_quality: bool, in_month: bool) -> SortPlan {
    match sort {
        "size_desc" | "size_asc" => SortPlan { uses_score: false, offset_paging: true, join: "" },
        // 全局按分数：缺分的行排最后（COALESCE -1），同分按时间倒序兜底。
        "quality_desc" => SortPlan { uses_score: has_quality, offset_paging: true, join: QUALITY_JOIN },
        // 当天内高分优先：跨天分组，必须 offset 分页。
        "day_desc_quality" => SortPlan { uses_score: has_quality, offset_paging: true, join: QUALITY_JOIN },
        // 纯时间序：不管是否点进了某个月，都保持用户选的那个排序，走 keyset 游标。
        "taken_desc" => SortPlan { uses_score: false, offset_paging: false, join: "" },
        _ => SortPlan { uses_score: false, offset_paging: false, join: "" },
    }
}

/// 订单子句（不含 LIMIT）。`key_col` 是 taken_sort（有索引）或 taken_at。
fn order_clause(sort: &str, has_quality: bool, key_col: &str) -> String {
    match sort {
        "size_desc" => " ORDER BY COALESCE(a.size,0) DESC, a.id DESC".to_string(),
        "size_asc" => " ORDER BY COALESCE(a.size,0) ASC, a.id ASC".to_string(),
        "quality_desc" if has_quality => {
            " ORDER BY COALESCE(q.score,-1) DESC, COALESCE(a.taken_at,'') DESC, a.id DESC".to_string()
        }
        "day_desc_quality" if has_quality => {
            " ORDER BY COALESCE(a.day,'') DESC, COALESCE(q.score,-1) DESC, COALESCE(a.taken_at,'') DESC, a.id DESC"
                .to_string()
        }
        // 没有评分表 / 非法排序：安静退回时间序，不能报错。
        "taken_asc" => format!(" ORDER BY {key_col} ASC, a.id ASC"),
        _ => format!(" ORDER BY {key_col} DESC, a.id DESC"),
    }
}

/// 深翻页游标，格式 taken_at|id（二元组）。命中时改写 where 并把参数追加到 args 末尾。
/// 返回 true 表示这是 keyset 分页，调用方应忽略 offset。
fn apply_cursor(
    where_sql: &mut String,
    args: &mut Vec<rusqlite::types::Value>,
    cursor: Option<&str>,
    key_col: &str,
) -> bool {
    let Some(raw) = cursor.map(str::trim).filter(|c| !c.is_empty()) else {
        return false;
    };
    let parts: Vec<&str> = raw.splitn(2, '|').collect();
    if parts.len() != 2 || parts[1].is_empty() {
        return false;
    }
    // key_col 是 taken_sort（COALESCE 生成列）：taken_at 为 NULL 的行归一成 ''，
    // 否则行值比较整体变 NULL，那些行会被静默跳过。
    let n = args.len();
    where_sql.push_str(&format!(
        " AND ({key_col}, a.id) < (?{}, ?{})",
        n + 1,
        n + 2
    ));
    args.push(rusqlite::types::Value::Text(parts[0].to_string()));
    args.push(rusqlite::types::Value::Text(parts[1].to_string()));
    true
}

/// 按月查看时的游标：score|taken_at|id。分数优先，同分按时间，再按 id。
fn apply_score_cursor(
    where_sql: &mut String,
    args: &mut Vec<rusqlite::types::Value>,
    cursor: Option<&str>,
) -> bool {
    let Some(raw) = cursor.map(str::trim).filter(|c| !c.is_empty()) else {
        return false;
    };
    let parts: Vec<&str> = raw.splitn(3, '|').collect();
    if parts.len() != 3 || parts[2].is_empty() {
        return false;
    }
    let Ok(score) = parts[0].parse::<f64>() else {
        return false;
    };
    args.push(rusqlite::types::Value::Real(score));
    args.push(rusqlite::types::Value::Text(parts[1].to_string()));
    args.push(rusqlite::types::Value::Text(parts[2].to_string()));
    where_sql.push_str(&format!(
        " AND (COALESCE(q.score,-1), COALESCE(a.taken_at,''), a.id) < (?{}, ?{}, ?{})",
        args.len() - 2,
        args.len() - 1,
        args.len()
    ));
    true
}

#[tauri::command]
fn query_assets(db: State<'_, Db>, filter: Filter) -> Result<Vec<AssetRow>, String> {
    let guard = db.open()?;
    let conn = guard.as_ref().unwrap();
    let has_dup = has_table(conn, "dup_groups") && has_table(conn, "dup_members");
    let (mut where_sql, mut args) = filter_where(&filter, has_table(conn, "asset_tags"), has_dup);
    let has_sort = has_column(conn, "assets", "taken_sort");
    if filter.cursor.as_deref().map(str::trim).is_some_and(|c| !c.is_empty()) && !has_sort {
        return Err("数据库缺少 taken_sort 列，请先运行一次 lifelog CLI 升级索引".to_string());
    }
    let key_col = if has_sort { "a.taken_sort" } else { "a.taken_at" };
    // 排序：taken_desc（默认）/ taken_asc / size_* / quality_desc / day_desc_quality。
    let sort = filter.sort.as_deref().unwrap_or("taken_desc");
    let has_quality = has_table(conn, "asset_quality");
    // 默认排序（taken_desc）始终是纯时间序：以前点进某个月会静默改成按分数排，
    // 用户以为是「时间线」却看到乱序。想让月内高分优先请显式选 day_desc_quality。
    let in_month = filter.day_from.is_some() && filter.day_to.is_some();
    let plan = sort_plan(sort, has_quality, in_month);
    let score_mode = plan.uses_score;
    // 按大小 / 按分数 / 当天内高分优先都要跨行分组，「上一页最后一条」不足以保证位置，
    // 一律退回 offset 分页（调用方已把 limit 限制在 MAX_PAGE_LIMIT 内）。
    let offset_paging = plan.offset_paging;
    let keyset = if !(sort == "taken_desc" && !offset_paging) {
        false
    } else {
        apply_cursor(&mut where_sql, &mut args, filter.cursor.as_deref(), key_col)
    };
    // 老库 / 测试库里可能还没有 asset_favorite：没有表时固定返回 0，不能整条查询失败。
    let favorite_col = if has_table(conn, "asset_favorite") {
        "(SELECT 1 FROM asset_favorite f WHERE f.asset_id = a.id) IS NOT NULL"
    } else {
        "0"
    };
    let score_col = if score_mode { ", q.score" } else { "" };
    let score_join = if score_mode { plan.join } else { "" };
    let dup_col = if has_dup {
        "(SELECT count(*) FROM dup_members dm WHERE dm.group_id = (SELECT dm2.group_id FROM dup_members dm2 WHERE dm2.asset_id = a.id LIMIT 1))".to_string()
    } else {
        "0".to_string()
    };
    // keeper 标记：网格卡片据此显示「保留」，不再需要额外拉成员映射。
    let keeper_col = if has_dup {
        "CASE WHEN (SELECT g2.keeper_id FROM dup_members dm3 JOIN dup_groups g2 ON g2.id = dm3.group_id WHERE dm3.asset_id = a.id LIMIT 1) = a.id THEN 1 ELSE 0 END".to_string()
    } else {
        "0".to_string()
    };
    let mut sql = format!(
        "SELECT a.id, a.path, a.day, a.taken_at, a.kind, \
                c.caption, c.scene, c.people, c.place, c.activity, c.mood, c.tags, c.ocr_text{},\
                {}, a.size, {}, {} \
         FROM assets a \
         LEFT JOIN captions c ON c.rowid = ( \
             SELECT rowid FROM captions c2 WHERE c2.asset_id = a.id ORDER BY c2.created_at DESC LIMIT 1){} \
         {}",
        score_col, favorite_col, dup_col, keeper_col, score_join, where_sql
    );


    sql.push_str(&order_clause(sort, has_quality, key_col));
    sql.push_str(" LIMIT ?");
    args.push(rusqlite::types::Value::Integer(filter.limit.unwrap_or(500)));
    sql.push_str(" OFFSET ?");
    args.push(rusqlite::types::Value::Integer(if keyset {
        0
    } else {
        filter.offset.unwrap_or(0)
    }));

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
                favorite: row.get::<_, Option<i64>>(13)?.unwrap_or(0) != 0,
                // 没有 asset_quality 表时 SELECT 里没有 q.score 这一列，后面两列要各退一位，
                // 否则 size 永远读成 None（空间页整列显示成「—」）。
                // 列位置随 score_mode 变化：score 存在时多一列，size/dup_count/keeper 都要顺延。
                score: if score_mode { row.get(14).ok() } else { None },
                size: if score_mode { row.get(15).ok() } else { row.get(14).ok() },
                dup_count: if score_mode { row.get(16).ok() } else { row.get(15).ok() },
                keeper: if score_mode { row.get(17).ok() } else { row.get(16).ok() },
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

#[derive(Serialize)]
struct AlbumRow {
    name: String,
    count: i64,
    cover_id: String,
    cover_thumb: String,
    preview_thumb: Vec<String>,
}

/// 相册卡片：封面取相册里美学分最高的一张，后面跟最多 3 张预览。
/// 按相册名累加：保留前 4 个 asset（1 张封面 + 3 张预览），count 统计全部。
fn fold_albums(rows: Vec<(String, String)>) -> Vec<(String, i64, Vec<String>)> {
    let mut order: Vec<String> = Vec::new();
    let mut acc: std::collections::HashMap<String, (i64, Vec<String>)> =
        std::collections::HashMap::new();
    for (name, asset_id) in rows {
        match acc.get_mut(&name) {
            Some(entry) => {
                entry.0 += 1;
                if entry.1.len() < 4 {
                    entry.1.push(asset_id);
                }
            }
            None => {
                order.push(name.clone());
                acc.insert(name, (1, vec![asset_id]));
            }
        }
    }
    order
        .into_iter()
        .map(|name| {
            let (count, ids) = acc.remove(&name).unwrap_or((0, Vec::new()));
            (name, count, ids)
        })
        .collect()
}

#[tauri::command]
fn album_groups(db: State<'_, Db>) -> Result<Vec<AlbumRow>, String> {
    let guard = db.open()?;
    let conn = guard.as_ref().unwrap();
    let order = if has_table(conn, "asset_quality") {
        "COALESCE(q.score,-1) DESC, a.taken_at DESC, a.id DESC"
    } else {
        "a.taken_at DESC, a.id DESC"
    };
    let join = if has_table(conn, "asset_quality") {
        " LEFT JOIN asset_quality q ON q.asset_id = a.id"
    } else {
        ""
    };
    let sql = format!(
        "SELECT al.name, aa.asset_id FROM albums al \
         JOIN album_assets aa ON aa.album_id = al.id \
         JOIN assets a ON a.id = aa.asset_id AND a.deleted_at IS NULL{} \
         ORDER BY al.name, {}",
        join, order
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;

    let collected: Vec<(String, String)> = rows.flatten().collect();
    let grouped = fold_albums(collected);

    let mut out: Vec<AlbumRow> = Vec::new();
    for (name, count, ids) in grouped {
        let cover_id = ids.first().cloned().unwrap_or_default();
        let cover_thumb = db.thumb_path(&cover_id);
        let preview_thumb = ids
            .iter()
            .skip(1)
            .take(3)
            .map(|id| db.thumb_path(id))
            .collect();
        out.push(AlbumRow {
            name,
            count,
            cover_id,
            cover_thumb,
            preview_thumb,
        });
    }
    Ok(out)
}

#[tauri::command]
fn facets(db: State<'_, Db>) -> Result<Facets, String> {
    let guard = db.open()?;
    let conn = guard.as_ref().unwrap();
    let mut facets = Facets::default();

    // 按「每个 asset 的最新一条 caption」统计，与 query_assets / count_assets 同源，
    // 否则分类卡片的数字（按 caption 行计）会和网格总数（按 asset 计）对不上。
    let mut stmt = conn
        .prepare(
            "SELECT c.tags, c.scene, c.people, c.place FROM assets a \
             LEFT JOIN captions c ON c.rowid = ( \
                 SELECT rowid FROM captions c2 WHERE c2.asset_id = a.id ORDER BY c2.created_at DESC LIMIT 1) \
             WHERE a.deleted_at IS NULL",
        )
        .map_err(|e| e.to_string())?;
    let mut tags: HashMap<String, i64> = HashMap::new();
    let mut scenes: HashMap<String, i64> = HashMap::new();
    let mut people: HashMap<String, i64> = HashMap::new();
    let mut places: HashMap<String, i64> = HashMap::new();
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
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
        // 地点可能是「上海、杭州」，按分隔符拆开计数，与前端分类页同口径
        for place in split_names(row.3, "places") {
            *places.entry(place).or_insert(0) += 1;
        }
    }
    let sorted = |map: HashMap<String, i64>| {
        let mut v: Vec<(String, i64)> = map.into_iter().collect();
        v.sort_by(|a, b| b.1.cmp(&a.1));
        v
    };
    facets.tags = sorted(tags);
    facets.places = sorted(places);
    facets.user_tags = conn
        .prepare("SELECT tag, count(*) FROM asset_tags GROUP BY tag ORDER BY count(*) DESC")
        .and_then(|mut stmt| {
            stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))
                .map(|rows| rows.flatten().collect())
        })
        .unwrap_or_default();
    facets.scenes = sorted(scenes);
    facets.people = sorted(people);

    let mut stmt = conn
        .prepare("SELECT substr(day,1,7) AS m, count(*) FROM assets WHERE deleted_at IS NULL AND day IS NOT NULL GROUP BY m ORDER BY m DESC")
        .map_err(|e| e.to_string())?;
    let months = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))
        .map_err(|e| e.to_string())?
        .flatten()
        .collect();
    facets.months = months;

    facets.albums = conn
        .prepare("SELECT al.name, count(aa.asset_id) FROM albums al LEFT JOIN album_assets aa ON aa.album_id = al.id GROUP BY al.id ORDER BY al.created_at DESC")
        .and_then(|mut stmt| {
            stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))
                .map(|rows| rows.flatten().collect())
        })
        .unwrap_or_default();
    Ok(facets)
}


#[derive(Deserialize)]
struct ExportArgs {
    ids: Option<Vec<String>>,
    filter: Option<Filter>,
    target: String,
}

fn load_export_rows(conn: &Connection, args: &ExportArgs) -> Result<Vec<export::Row>, String> {
    let (where_sql, mut params) = match (&args.ids, &args.filter) {
        (Some(ids), _) if !ids.is_empty() => {
            let placeholders = vec!["?"; ids.len()].join(",");
            let mut values: Vec<rusqlite::types::Value> = ids
                .iter()
                .map(|id| rusqlite::types::Value::Text(id.clone()))
                .collect();
            (
                format!(" WHERE a.deleted_at IS NULL AND a.id IN ({placeholders})"),
                values,
            )
        }
        (_, Some(filter)) => filter_where(
            filter,
            has_table(conn, "asset_tags"),
            has_table(conn, "dup_groups") && has_table(conn, "dup_members"),
        ),
        _ => (String::from(" WHERE a.deleted_at IS NULL"), Vec::new()),
    };
    let sql = format!(
        "SELECT a.id, a.path, a.day, a.taken_at, c.caption, c.scene, c.people, c.place,                 c.activity, c.mood, c.tags, c.ocr_text          FROM assets a          LEFT JOIN captions c ON c.rowid = (              SELECT rowid FROM captions c2 WHERE c2.asset_id = a.id ORDER BY c2.created_at DESC LIMIT 1)          {}",
        where_sql
    );
    let _ = &mut params;
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params_from_iter(params.iter()), |row| {
            Ok(export::Row {
                id: row.get(0)?,
                path: row.get(1)?,
                day: row.get(2)?,
                taken_at: row.get(3)?,
                caption: row.get(4)?,
                scene: row.get(5)?,
                people: row.get(6)?,
                place: row.get(7)?,
                activity: row.get(8)?,
                mood: row.get(9)?,
                tags: parse_tags(row.get(10)?),
                ocr_text: row.get(11)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[tauri::command]
async fn export_assets(db: State<'_, Db>, args: ExportArgs) -> Result<serde_json::Value, String> {
    let home = db.data_dir.clone();
    let db_path = db.path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = Connection::open_with_flags(
            &db_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| e.to_string())?;
        let rows = load_export_rows(&conn, &args)?;
        let target = PathBuf::from(&args.target);
        if !target.is_dir() {
            return Err(format!("目标目录不存在：{}", target.display()));
        }
        let summary = export::export_rows(&rows, &home, &target)?;
        serde_json::to_value(summary).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 系统默认播放器 / 预览打开：视频格式 WebView 解不了时用它兜底。
#[tauri::command]
fn open_external(path: String) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(path)
        .status()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    std::process::Command::new("open")
        .arg("-R")
        .arg(path)
        .status()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// 把文件移进系统废纸篓（macOS 用 NSFileManager，其它平台用 crate 默认实现）。
#[cfg(target_os = "macos")]
fn trash_with(path: &std::path::Path) -> Result<(), trash::Error> {
    use trash::macos::{DeleteMethod, TrashContextExtMacos};
    let mut ctx = trash::TrashContext::new();
    ctx.set_delete_method(DeleteMethod::NsFileManager);
    ctx.delete(path)
}

#[cfg(not(target_os = "macos"))]
fn trash_with(path: &std::path::Path) -> Result<(), trash::Error> {
    trash::delete(path)
}

// 清单读写走 Python 侧（lifelog/space.py）：命令行、测试和桌面端同一份实现，
// 也能保证 config.DB_PATH 与桌面端实际打开的库是同一个文件。

#[tauri::command]
async fn import_summary(db: State<'_, Db>) -> Result<serde_json::Value, String> {
    let home = db.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_python_cli(&home, &["import-summary".to_string()])
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn space_views(db: State<'_, Db>) -> Result<serde_json::Value, String> {
    let home = db.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || run_python_cli(&home, &["space-views".to_string()]))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn space_groups(
    db: State<'_, Db>,
    view: String,
    limit: Option<i64>,
    offset: Option<i64>,
    group: Option<String>,
) -> Result<serde_json::Value, String> {
    let home = db.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut args = vec!["space-groups".to_string(), "--view".to_string(), view];
        if let Some(limit) = limit {
            args.push("--limit".to_string());
            args.push(limit.to_string());
        }
        if let Some(offset) = offset.filter(|value| *value > 0) {
            args.push("--offset".to_string());
            args.push(offset.to_string());
        }
        if let Some(group) = group.filter(|value| !value.trim().is_empty()) {
            args.push("--group".to_string());
            args.push(group);
        }
        run_python_cli(&home, &args)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn space_versions(db: State<'_, Db>) -> Result<serde_json::Value, String> {
    let home = db.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || run_python_cli(&home, &["space-versions".to_string()]))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn cleanup_list(db: State<'_, Db>) -> Result<serde_json::Value, String> {
    let home = db.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || run_python_cli(&home, &["cleanup-list".to_string()]))
        .await
        .map_err(|err| err.to_string())?
}

/// 加入待清理：只写 cleanup_queue，不动文件、不删 assets 行。
#[tauri::command]
async fn cleanup_add(
    db: State<'_, Db>,
    ids: Vec<String>,
    source: Option<String>,
) -> Result<serde_json::Value, String> {
    let home = db.data_dir.clone();
    let source = source.unwrap_or_else(|| "space".to_string());
    let source = if source.trim().is_empty() { "space".to_string() } else { source };
    tauri::async_runtime::spawn_blocking(move || {
        run_python_cli(
            &home,
            &[
                "cleanup-add".to_string(),
                "--ids".to_string(),
                ids.join(","),
                "--source".to_string(),
                source,
            ],
        )
    })
    .await
    .map_err(|err| err.to_string())?
}

/// 从待清理里移出（还原），只删清单行。
#[tauri::command]
async fn cleanup_remove(db: State<'_, Db>, ids: Vec<String>) -> Result<serde_json::Value, String> {
    let home = db.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_python_cli(
            &home,
            &["cleanup-remove".to_string(), "--ids".to_string(), ids.join(",")],
        )
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn space_summary(db: State<'_, Db>) -> Result<serde_json::Value, String> {
    let home = db.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || run_python_cli(&home, &["space-summary".to_string()]))
        .await
        .map_err(|err| err.to_string())?
}

/// 软删除：只写 deleted_at，不动文件；真正的物理删除在 empty_trash。
#[tauri::command]
async fn delete_records(
    db: State<'_, Db>,
    ids: Vec<String>,
    between: Option<String>,
) -> Result<serde_json::Value, String> {
    let _ = between;
    let home = db.data_dir.clone();
    let ids: Vec<String> = ids.into_iter().filter(|id| !id.trim().is_empty()).collect();
    if ids.is_empty() {
        return Err("没有选中要删除的照片".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        run_python_cli(
            &home,
            &["record-trash".to_string(), "--ids".to_string(), ids.join(",")],
        )
    })
    .await
    .map_err(|err| err.to_string())?
}

/// 还原：清空 deleted_at，照片回到原来的位置。
#[tauri::command]
async fn favorite_add(db: State<'_, Db>, ids: Vec<String>) -> Result<serde_json::Value, String> {
    let home = db.data_dir.clone();
    let ids: Vec<String> = ids.into_iter().filter(|id| !id.trim().is_empty()).collect();
    if ids.is_empty() {
        return Err("没有选中要收藏的照片".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        run_python_cli(
            &home,
            &["favorite-add".to_string(), "--ids".to_string(), ids.join(",")],
        )
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn favorite_remove(db: State<'_, Db>, ids: Vec<String>) -> Result<serde_json::Value, String> {
    let home = db.data_dir.clone();
    let ids: Vec<String> = ids.into_iter().filter(|id| !id.trim().is_empty()).collect();
    if ids.is_empty() {
        return Err("没有选中要取消收藏的照片".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        run_python_cli(
            &home,
            &["favorite-remove".to_string(), "--ids".to_string(), ids.join(",")],
        )
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn favorite_list(db: State<'_, Db>) -> Result<serde_json::Value, String> {
    let home = db.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_python_cli(&home, &["favorite-list".to_string()])
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn restore_records(
    db: State<'_, Db>,
    ids: Vec<String>,
) -> Result<serde_json::Value, String> {
    let home = db.data_dir.clone();
    let ids: Vec<String> = ids.into_iter().filter(|id| !id.trim().is_empty()).collect();
    if ids.is_empty() {
        return Err("没有选中要还原的照片".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        run_python_cli(
            &home,
            &["record-restore".to_string(), "--ids".to_string(), ids.join(",")],
        )
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn trash_list(
    db: State<'_, Db>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<serde_json::Value, String> {
    let home = db.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut args = vec!["trash-list".to_string()];
        if let Some(limit) = limit {
            args.push("--limit".to_string());
            args.push(limit.to_string());
        }
        if let Some(offset) = offset.filter(|value| *value > 0) {
            args.push("--offset".to_string());
            args.push(offset.to_string());
        }
        run_python_cli(&home, &args)
    })
    .await
    .map_err(|err| err.to_string())?
}

/// 清空最近删除：先移文件进系统废纸篓，再删记录。有一张移不动就整体停下。
#[tauri::command]
async fn empty_trash(
    db: State<'_, Db>,
    ids: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    let home = db.data_dir.clone();
    // 查询放在独立作用域里：连接与语句都必须在 await 之前释放，否则 future 不是 Send。
    let target_ids: Vec<String> = match ids {
        Some(list) => list.into_iter().filter(|id| !id.trim().is_empty()).collect(),
        None => {
            let conn = open_conn(&home)?;
            let mut stmt = conn
                .prepare("SELECT id FROM assets WHERE deleted_at IS NOT NULL")
                .map_err(|e| e.to_string())?;
            let rows: Vec<String> = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .flatten()
                .collect();
            rows
        }
    };
    if target_ids.is_empty() {
        return Ok(serde_json::json!({ "ok": true, "requested": 0, "files": { "trashed": 0 } }));
    }

    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_conn(&home)?;
        let marks = vec!["?"; target_ids.len()].join(",");
        let mut stmt = conn
            .prepare(&format!("SELECT path FROM assets WHERE id IN ({marks})"))
            .map_err(|e| e.to_string())?;
        let paths: Vec<String> = stmt
            .query_map(params_from_iter(target_ids.iter()), |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .flatten()
            .collect();
        drop(stmt);
        drop(conn);

        let mut trashed = 0usize;
        let mut missing = 0usize;
        let mut failed: Vec<String> = Vec::new();
        for raw in &paths {
            let path = std::path::PathBuf::from(raw);
            if !path.exists() {
                missing += 1;
                continue;
            }
            match trash_with(&path) {
                Ok(()) => trashed += 1,
                Err(err) => failed.push(format!("{}: {err}", path.display())),
            }
        }
        if !failed.is_empty() {
            if let Some(hint) = permission_hint(&failed) {
                return Err(hint);
            }
            return Err(format!(
                "有 {} 个文件无法移到废纸篓，已停止且未删除任何记录（{}）",
                failed.len(),
                failed[0]
            ));
        }

        let result = run_python_cli(
            &home,
            &["trash-empty".to_string(), "--ids".to_string(), target_ids.join(",")],
        )?;
        let _ = run_python_cli(
            &home,
            &["thumbs-prune".to_string(), "--ids".to_string(), target_ids.join(",")],
        );
        let mut out = result;
        if let serde_json::Value::Object(map) = &mut out {
            map.insert(
                "files".to_string(),
                serde_json::json!({
                    "requested": paths.len(),
                    "trashed": trashed,
                    "missing": missing,
                }),
            );
        }
        Ok(out)
    })
    .await
    .map_err(|err| err.to_string())?
}

/// 启动时的自动清理：把超过保留期的记录移进系统废纸篓并删行。
/// 与 empty_trash 共用同一套顺序（先移文件，失败就保留记录）。
fn purge_expired_now(home: &Path) -> Result<usize, String> {
    let expired = run_python_cli(home, &["trash-expired".to_string()])?;
    let ids: Vec<String> = expired
        .get("ids")
        .and_then(|value| value.as_array())
        .map(|list| list.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    if ids.is_empty() {
        return Ok(0);
    }
    let marks = vec!["?"; ids.len()].join(",");
    let occurred = {
        let conn = open_conn(home)?;
        let mut stmt = conn
            .prepare(&format!("SELECT path FROM assets WHERE id IN ({marks})"))
            .map_err(|e| e.to_string())?;
        let rows: Vec<String> = stmt
            .query_map(params_from_iter(ids.iter()), |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .flatten()
            .collect();
        rows
    };
    for raw in &occurred {
        let path = std::path::PathBuf::from(raw);
        if path.exists() {
            // 移不动就整批跳过，避免出现「文件还在、记录没了」的孤儿。
            if trash_with(&path).is_err() {
                return Ok(0);
            }
        }
    }
    run_python_cli(
        home,
        &["trash-empty".to_string(), "--ids".to_string(), ids.join(",")],
    )?;
    Ok(ids.len())
}

/// 手动触发一次（设置页/调试用）；平时由启动钩子调用。
#[tauri::command]
async fn trash_purge_expired(db: State<'_, Db>) -> Result<serde_json::Value, String> {
    let home = db.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let purged = purge_expired_now(&home)?;
        Ok(serde_json::json!({ "ok": true, "purged": purged }))
    })
    .await
    .map_err(|err| err.to_string())?
}
#[tauri::command]
async fn import_xiaomi(app: AppHandle, db: State<'_, Db>, dry_run: bool) -> Result<serde_json::Value, String> {
    let home = db.data_dir.clone();
    let repo = repo_root();
    tauri::async_runtime::spawn_blocking(move || {
        let mut args: Vec<String> = vec![
            "-m".to_string(),
            "lifelog.cli".to_string(),
            "sync".to_string(),
        ];
        if dry_run {
            args.push("--dry-run".to_string());
        } else {
            args.push("--json".to_string());
        }
        let python = py::resolve(&home)?;
        let output = Command::new(python)
            .current_dir(&repo)
            .args(&args)
            .env("LIFELOG_HOME", &home)
            .output()
            .map_err(|e| e.to_string())?;
        // 只透出 JSON 里的进度事件，stderr 不回显，避免任何凭据外泄。
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let mut last = serde_json::Value::Null;
        for line in stdout.lines() {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
                let _ = app.emit("import-progress", &value);
                last = value;
            }
        }
        if !output.status.success() {
            let message = last
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("导入失败")
                .to_string();
            let code = last
                .get("code")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            return Err(serde_json::json!({"message": message, "code": code}).to_string());
        }
        Ok(last)
    })
    .await
    .map_err(|e| e.to_string())?
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

fn count_jpgs(dir: &Path) -> i64 {
    std::fs::read_dir(dir)
        .map(|items| {
            items
                .filter_map(|entry| entry.ok())
                .filter(|entry| entry.path().extension().map(|ext| ext == "jpg").unwrap_or(false))
                .count() as i64
        })
        .unwrap_or(0)
}

#[tauri::command]
fn thumb_status(db: State<'_, Db>) -> Result<serde_json::Value, String> {
    let thumbs = count_jpgs(&db.data_dir.join("thumbs"));
    let full = count_jpgs(&db.data_dir.join("thumbs").join("full"));
    let guard = db.open()?;
    let conn = guard.as_ref().unwrap();
    let assets: i64 = conn
        .query_row(
            "SELECT count(*) FROM assets WHERE deleted_at IS NULL",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    Ok(serde_json::json!({
        "assets": assets,
        "thumbs": thumbs,
        "full": full,
        "missing": (assets - thumbs).max(0),
    }))
}

#[tauri::command]
async fn generate_thumbs(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    force: bool,
) -> Result<serde_json::Value, String> {
    let home = db.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = desktop_root();
        let script = root.join("scripts/gen_thumbs.py");
        if !script.exists() {
            return Err(format!("找不到缩略图脚本：{}", script.display()));
        }
        let python = py::resolve(&home)?;
        let mut command = std::process::Command::new(python);
        command
            .arg(&script)
            .arg("--json")
            .arg("--jobs")
            .arg("6")
            .current_dir(&root)
            .env("LIFELOG_HOME", &home)
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if force {
            command.arg("--force");
        }
        let mut child = command
            .spawn()
            .map_err(|err| format!("启动缩略图生成失败：{err}"))?;
        if let Some(stdout) = child.stdout.take() {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                    let _ = app.emit("thumbs-progress", value);
                }
            }
        }
        let status = child.wait().map_err(|err| err.to_string())?;
        Ok(serde_json::json!({"ok": status.success()}))
    })
    .await
    .map_err(|err| err.to_string())?
}

/// 导入本地文件夹：先跑 Python 的 ingest，再补齐缩略图，两步都流式回报。
/// Python 侧默认把库放在 $LIFELOG_HOME/lifelog.sqlite；桌面端允许用 LIFELOG_DB 单独指定，
/// 这里必须把这个设置传过去，否则清单会写到另一个库里。
fn python_db_path(home: &Path) -> PathBuf {
    std::env::var("LIFELOG_DB")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home.join("lifelog.sqlite"))
}

/// 重复图视角：把所有组的非 keeper 一次性加入待清理（服务端 INSERT…SELECT）。
#[tauri::command]
async fn cleanup_add_all_dup(db: State<'_, Db>) -> Result<serde_json::Value, String> {
    let home = db.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_python_cli(&home, &["cleanup-add-all-dup".to_string()])
    })
    .await
    .map_err(|err| err.to_string())?
}

/// 从界面「立即计算指纹」触发：跑一次 lifelog dedup --build。
#[tauri::command]
async fn dedup_build(db: State<'_, Db>) -> Result<serde_json::Value, String> {
    let home = db.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_python_cli(&home, &["dedup".to_string(), "--build".to_string()])
    })
    .await
    .map_err(|err| err.to_string())?
}

/// 诊断用：返回当前会使用的 Python 解释器（含 Pillow）。
#[tauri::command]
fn python_report(db: State<'_, Db>) -> serde_json::Value {
    py::report(&db.data_dir)
}

fn run_python_cli(home: &Path, args: &[String]) -> Result<serde_json::Value, String> {
    // lifelog 包在仓库根目录，不在 desktop/ 下；用 desktop_root 会 ModuleNotFoundError
    let root = repo_root();
    let python = py::resolve(home)?;
    let output = std::process::Command::new(python)
        .arg("-c")
        .arg("from lifelog.cli import main; main()")
        .args(args)
        .current_dir(&root)
        .env("PYTHONPATH", &root)
        .env("LIFELOG_HOME", home)
        .env("LIFELOG_DB", python_db_path(home))
        .output()
        .map_err(|err| format!("启动 Python 侧失败：{err}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(stdout.trim())
        .map_err(|err| format!("解析 Python 输出失败：{err}｜{stdout}"))
}

#[tauri::command]
async fn bulk_tag(
    db: State<'_, Db>,
    ids: Vec<String>,
    tag: String,
    remove: bool,
) -> Result<serde_json::Value, String> {
    let home = db.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let args = vec![
            if remove { "tag-remove" } else { "tag-add" }.to_string(),
            tag,
            "--ids".to_string(),
            ids.join(","),
        ];
        run_python_cli(&home, &args)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn album_create(db: State<'_, Db>, name: String) -> Result<serde_json::Value, String> {
    let home = db.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_python_cli(&home, &["album-create".to_string(), name])
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn album_add(
    db: State<'_, Db>,
    name: String,
    ids: Vec<String>,
    remove: bool,
) -> Result<serde_json::Value, String> {
    let home = db.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let args = vec![
            if remove { "album-remove" } else { "album-add" }.to_string(),
            name,
            "--ids".to_string(),
            ids.join(","),
        ];
        run_python_cli(&home, &args)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn album_list(db: State<'_, Db>) -> Result<serde_json::Value, String> {
    let home = db.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_python_cli(&home, &["album-list".to_string()])
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn import_folder(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    path: String,
) -> Result<serde_json::Value, String> {
    let home = db.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = repo_root();
        let _ = app.emit("import-progress", serde_json::json!({"stage": "ingest", "message": "正在扫描文件夹"}));
        let python = py::resolve(&home)?;
        // 与 ingest_probe 共用同一条读取路径：边跑边把进度转发给前端。
        let mut failed_message: Option<String> = None;
        let stats = stream_ingest_events(&python, &root, &home, &path, |value| {
            let _ = app.emit("import-progress", value);
        })
        .unwrap_or_else(|err| {
            failed_message = Some(err.clone());
            serde_json::Value::Null
        });
        if let Some(message) = failed_message {
            let _ = app.emit("import-progress", serde_json::json!({"stage": "failed", "message": message}));
            return Ok(serde_json::json!({"ok": false, "stderr": message}));
        }
        let _ = app.emit("import-progress", serde_json::json!({"stage": "ingest-done", "stats": stats}));

        // 导入完成后自动补齐缩略图
        let script = root.join("scripts/gen_thumbs.py");
        if script.exists() {
            let _ = app.emit("import-progress", serde_json::json!({"stage": "thumbs", "message": "正在生成缩略图"}));
            let python = py::resolve(&home)?;
            if let Ok(mut child) = std::process::Command::new(python)
                .arg(&script)
                .arg("--json")
                .arg("--jobs")
                .arg("6")
                .current_dir(&root)
                .env("LIFELOG_HOME", &home)
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
            {
                if let Some(stdout) = child.stdout.take() {
                    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                            let _ = app.emit("thumbs-progress", value);
                        }
                    }
                }
                let _ = child.wait();
            }
        }
        Ok(serde_json::json!({"ok": true, "stats": stats}))
    })
    .await
    .map_err(|err| err.to_string())?
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
        let python = py::resolve(&home)?;
        let output = std::process::Command::new(python)
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
        // 仅压测用：设置 LIFELOG_BENCH_FOCUS=1 时启动即把窗口置前，
        // 否则 WKWebView 在后台会节流 rAF，滚动帧率根本测不出来。
        .setup(|app| {
            // 启动时清掉超过保留期的回收站记录：移到系统废纸篓 + 删行。
            // 只在后台跑一次，不常驻；失败不影响启动。
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let state = handle.state::<Db>();
                    let home = state.data_dir.clone();
                    drop(state);
                    if let Err(err) = purge_expired_now(&home) {
                        eprintln!("[trash] 自动清理失败：{err}");
                    }
                });
            }
            if std::env::var("LIFELOG_BENCH_FOCUS").is_ok() {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Db {
            path: db_path,
            data_dir,
            conn: Mutex::new(None),
        })
        .manage(sidecar)
        .invoke_handler(tauri::generate_handler![
            library_stats,
            library_state,
            favorite_add,
            favorite_remove,
            favorite_list,
            use_library,
            create_library,
            query_assets,
            count_assets,
            export_assets,
            import_xiaomi,
            delete_records,
            restore_records,
            trash_list,
            empty_trash,
            trash_purge_expired,
            library_access,
            open_privacy_settings,
            reveal_in_finder,
            open_external,
            python_report,
            dedup_build,
            cleanup_add_all_dup,
            facets,
            timeline_months,
            album_groups,
            category_groups,
            health,
            app_settings,
            rebuild_thumbs,
            thumb_status,
            generate_thumbs,
            import_folder,
            bulk_tag,
            album_create,
            album_add,
            album_list,
            dup_groups,
            cleanup_list,
            cleanup_add,
            cleanup_remove,
            space_summary,
            space_views,
            import_summary,
            space_groups,
            space_versions,
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

#[cfg(test)]
mod filter_tests {
    use super::*;

    fn seed() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE assets (id TEXT PRIMARY KEY, path TEXT, day TEXT, taken_at TEXT, kind TEXT, deleted_at TEXT);
             CREATE TABLE captions (rowid INTEGER PRIMARY KEY, asset_id TEXT, caption TEXT, scene TEXT,
                                    people TEXT, place TEXT, activity TEXT, mood TEXT, tags TEXT,
                                    ocr_text TEXT, created_at TEXT);
             CREATE TABLE asset_tags (asset_id TEXT, tag TEXT, created_at TEXT);
             CREATE TABLE albums (id TEXT PRIMARY KEY, name TEXT, created_at TEXT);
             CREATE TABLE album_assets (album_id TEXT, asset_id TEXT, added_at TEXT);
             INSERT INTO assets (id, path, day, taken_at, kind) VALUES ('a1','/p/1.jpg','2024-01-01','2024-01-01T10:00:00','image');
             INSERT INTO assets (id, path, day, taken_at, kind) VALUES ('a2','/p/2.jpg','2024-01-02','2024-01-02T10:00:00','image');
             INSERT INTO assets (id, path, day, taken_at, kind) VALUES ('a3','/p/3.jpg','2024-01-03','2024-01-03T10:00:00','image');
             INSERT INTO captions VALUES (1,'a1','海边日落','户外','一人','海边','休息','平静','[\"风景\"]',NULL,'2024-01-01');
             INSERT INTO captions VALUES (2,'a2','山间徒步','户外','一人','山里','行走','平静','[\"风景\"]',NULL,'2024-01-02');
             INSERT INTO captions VALUES (3,'a3','室内看书','室内居家','多人','家','阅读','安静','[\"人物\"]',NULL,'2024-01-03');",
        )
        .unwrap();
        conn
    }

    fn count(conn: &rusqlite::Connection, filter: &Filter) -> i64 {
        let (where_sql, args) = filter_where(filter, true, false);
        let sql = format!(
            "SELECT count(*) FROM assets a \
             LEFT JOIN captions c ON c.rowid = ( \
                 SELECT rowid FROM captions c2 WHERE c2.asset_id = a.id ORDER BY c2.created_at DESC LIMIT 1) \
             {}",
            where_sql
        );
        conn.query_row(&sql, params_from_iter(args.iter()), |row| row.get(0)).unwrap()
    }

    fn list(conn: &rusqlite::Connection, filter: &Filter) -> usize {
        let (where_sql, mut args) = filter_where(filter, true, false);
        let mut sql = format!(
            "SELECT a.id FROM assets a \
             LEFT JOIN captions c ON c.rowid = ( \
                 SELECT rowid FROM captions c2 WHERE c2.asset_id = a.id ORDER BY c2.created_at DESC LIMIT 1) \
             {}",
            where_sql
        );
        sql.push_str(" ORDER BY a.taken_at DESC, a.day DESC LIMIT ?");
        args.push(rusqlite::types::Value::Integer(filter.limit.unwrap_or(500)));
        sql.push_str(" OFFSET ?");
        args.push(rusqlite::types::Value::Integer(filter.offset.unwrap_or(0)));
        let mut stmt = conn.prepare(&sql).unwrap();
        stmt.query_map(params_from_iter(args.iter()), |_| Ok(())).unwrap().count()
    }

    fn filter() -> Filter {
        Filter {
            query: None,
            tag: None,
            album: None,
            scene: None,
            person: None,
            place: None,
            kind: None,
            day_from: None,
            day_to: None,
            limit: None,
            offset: None,
            cursor: None,
            sort: None,
            view: None,
            favorite: None,
        }
    }

    #[test]
    fn scene_filter_counts_and_lists_same_rows() {
        let conn = seed();
        let mut f = filter();
        f.scene = Some("户外".into());
        assert_eq!(count(&conn, &f), 2);
        assert_eq!(list(&conn, &f), 2);
    }

    #[test]
    fn person_and_place_filter_apply_on_server() {
        let conn = seed();
        let mut f = filter();
        f.person = Some("一人".into());
        assert_eq!(count(&conn, &f), 2);
        f.place = Some("海边".into());
        assert_eq!(count(&conn, &f), 1);
        assert_eq!(list(&conn, &f), 1);
    }

    #[test]
    fn limit_and_offset_do_not_break_placeholders() {
        let conn = seed();
        let mut f = filter();
        f.scene = Some("户外".into());
        f.limit = Some(1);
        f.offset = Some(1);
        assert_eq!(list(&conn, &f), 1);
    }

    #[test]
    fn view_filters_match_cleanup_views() {
        let conn = seed();
        conn.execute_batch("ALTER TABLE assets ADD COLUMN size INTEGER").unwrap();
        conn.execute_batch("UPDATE assets SET size = 100 WHERE id = 'a1'").unwrap();
        conn.execute_batch("UPDATE assets SET size = 900 WHERE id = 'a2'").unwrap();
        conn.execute_batch("UPDATE assets SET size = 900 WHERE id = 'a3'").unwrap();
        conn.execute_batch("INSERT INTO assets (id,path,day,taken_at,kind) VALUES ('v1','/p/v.mp4','2024-01-04','2024-01-04T10:00:00','video')").unwrap();
        conn.execute_batch("UPDATE assets SET size = 5000 WHERE id = 'v1'").unwrap();
        conn.execute_batch("INSERT INTO assets (id,path,day,taken_at,kind) VALUES ('s1','/p/Screenshot_1.png','2024-01-05','2024-01-05T10:00:00','image')").unwrap();
        conn.execute_batch("UPDATE assets SET size = 700 WHERE id = 's1'").unwrap();
        conn.execute_batch("INSERT INTO captions VALUES (4,'s1','手机截图','屏幕截图','无','手机','查看','平静','[\"屏幕截图\"]',NULL,'2024-01-05')").unwrap();

        // 真实去重表：dup 视角从 dup_members 取，keeper 也在里面。
        conn.execute_batch(
            "CREATE TABLE dup_groups (id INTEGER PRIMARY KEY, keeper_id TEXT, reason TEXT, created_at TEXT);
             CREATE TABLE dup_members (group_id INTEGER, asset_id TEXT, distance INTEGER, PRIMARY KEY (group_id, asset_id));
             INSERT INTO dup_groups VALUES (1, 'a2', 'l1', '2024-01-01');
             INSERT INTO dup_members VALUES (1, 'a2', 0);
             INSERT INTO dup_members VALUES (1, 'a3', 3);",
        )
        .unwrap();

        let count = |view: &str| -> i64 {
            let mut f = filter();
            f.view = Some(view.into());
            let (where_sql, args) = filter_where(&f, true, true);
            let sql = format!(
                "SELECT count(*) FROM assets a \
                 LEFT JOIN captions c ON c.rowid = ( \
                     SELECT rowid FROM captions c2 WHERE c2.asset_id = a.id ORDER BY c2.created_at DESC LIMIT 1) \
                 {}",
                where_sql
            );
            conn.query_row(&sql, params_from_iter(args.iter()), |row| row.get(0)).unwrap()
        };

        assert_eq!(count("large"), 5);
        // 真实去重表：keeper a2 + 成员 a3
        assert_eq!(count("dup"), 2);
        // 没有 dup 表时不能拿「同 size」冒充重复，应返回 0（前端显示「正在计算指纹」）。
        let missing = {
            let mut f = filter();
            f.view = Some("dup".into());
            let (where_sql, args) = filter_where(&f, true, false);
            conn.query_row(
                &format!("SELECT count(*) FROM assets a {where_sql}"),
                params_from_iter(args.iter()),
                |row| row.get::<_, i64>(0),
            )
            .unwrap()
        };
        assert_eq!(missing, 0);
        assert_eq!(count("video"), 1);
        assert_eq!(count("photo"), 4);
        // 路径命中 Screenshot + caption 的 scene/tags 命中，两层都算
        assert_eq!(count("screenshot"), 1);
    }

    #[test]
    fn asset_dup_count_and_keeper_survive_without_score_column() {
        // dup_count / keeper 也排在 score、size 之后：没有评分表时不能错位。
        let conn = seed();
        conn.execute_batch(
            "ALTER TABLE assets ADD COLUMN size INTEGER;",
        )
        .unwrap();
        conn.execute_batch(
            "CREATE TABLE dup_groups (id INTEGER PRIMARY KEY, keeper_id TEXT, reason TEXT, created_at TEXT);
             CREATE TABLE dup_members (group_id INTEGER, asset_id TEXT, distance INTEGER, PRIMARY KEY (group_id, asset_id));
             INSERT INTO dup_groups VALUES (1, 'a1', 'burst', '2024-01-01');
             INSERT INTO dup_members VALUES (1, 'a1', 0);
             INSERT INTO dup_members VALUES (1, 'a2', 4);",
        )
        .unwrap();
        let sql = "SELECT a.id, a.path, a.day, a.taken_at, a.kind, \
                          c.caption, c.scene, c.people, c.place, c.activity, c.mood, c.tags, c.ocr_text, a.size, \
                          (SELECT count(*) FROM dup_members dm WHERE dm.group_id = (SELECT dm2.group_id FROM dup_members dm2 WHERE dm2.asset_id = a.id LIMIT 1)), \
                          CASE WHEN (SELECT g2.keeper_id FROM dup_members dm3 JOIN dup_groups g2 ON g2.id = dm3.group_id WHERE dm3.asset_id = a.id LIMIT 1) = a.id THEN 1 ELSE 0 END \
                   FROM assets a LEFT JOIN captions c ON c.rowid = (SELECT rowid FROM captions c2 WHERE c2.asset_id = a.id ORDER BY c2.created_at DESC LIMIT 1) \
                   WHERE a.id = 'a1'";
        let (dup_count, keeper): (Option<i64>, Option<i64>) = conn
            .query_row(sql, [], |row| Ok((row.get(14).ok(), row.get(15).ok())))
            .unwrap();
        assert_eq!(dup_count, Some(2), "dup_count 应读在第 14 列");
        assert_eq!(keeper, Some(1), "keeper 应读在第 15 列");
    }

    #[test]
    fn asset_size_survives_without_score_column() {
        // 没有 asset_quality 表时 SELECT 少一列，size 不能跟着错位成 None。
        let conn = seed();
        // 测试 schema 里 assets 没有 size 列，真实库有。
        conn.execute_batch(
            "ALTER TABLE assets ADD COLUMN size INTEGER; UPDATE assets SET size = 12345 WHERE id = 'a1';",
        )
        .unwrap();
        // 与 query_assets 一致：有收藏表时第 13 列是 favorite，size 在 14 列（无评分表）。
        conn.execute_batch("CREATE TABLE IF NOT EXISTS asset_favorite (asset_id TEXT PRIMARY KEY, created_at TEXT)").unwrap();
        let sql = "SELECT a.id, a.path, a.day, a.taken_at, a.kind,                 c.caption, c.scene, c.people, c.place, c.activity, c.mood, c.tags, c.ocr_text,                 (SELECT 1 FROM asset_favorite f WHERE f.asset_id = a.id), a.size          FROM assets a LEFT JOIN captions c ON c.rowid = (              SELECT rowid FROM captions c2 WHERE c2.asset_id = a.id ORDER BY c2.created_at DESC LIMIT 1)          WHERE a.id = 'a1'";
        // 与 query_assets 里 score_mode=false 时的列下标保持一致
        // 多了一列 favorite，size 从第 13 列顺延到第 14 列
        let size: Option<i64> = conn.query_row(sql, [], |row| Ok(row.get(14).ok())).unwrap();
        assert_eq!(size, Some(12345), "size 应读在第 14 列");
    }

    #[test]
    fn tag_filter_is_exact_not_substring() {
        let conn = seed();
        conn.execute(r#"UPDATE captions SET tags = '["运动户外"]' WHERE rowid = 2"#, []).unwrap();
        let mut f = filter();
        f.tag = Some("户外".into());
        assert_eq!(count(&conn, &f), 0, "「户外」不应命中「运动户外」");
        f.tag = Some("运动户外".into());
        assert_eq!(count(&conn, &f), 1);
    }

    #[test]
    fn facets_counts_match_count_assets() {
        let conn = seed();
        let base = "FROM assets a LEFT JOIN captions c ON c.rowid = (             SELECT rowid FROM captions c2 WHERE c2.asset_id = a.id ORDER BY c2.created_at DESC LIMIT 1)";

        let mut f = filter();
        f.scene = Some("户外".into());
        let facet_scene: i64 = conn
            .query_row(&format!("SELECT count(*) {base} WHERE c.scene = '户外'"), [], |r| r.get(0))
            .unwrap();
        assert_eq!(facet_scene, count(&conn, &f), "scene 维度 facets 与 count_assets 不一致");

        let mut f = filter();
        f.person = Some("一人".into());
        let facet_person: i64 = conn
            .query_row(&format!("SELECT count(*) {base} WHERE c.people LIKE '%一人%'"), [], |r| r.get(0))
            .unwrap();
        assert_eq!(facet_person, count(&conn, &f), "person 维度不一致");

        let mut f = filter();
        f.place = Some("海边".into());
        let facet_place: i64 = conn
            .query_row(&format!("SELECT count(*) {base} WHERE c.place LIKE '%海边%'"), [], |r| r.get(0))
            .unwrap();
        assert_eq!(facet_place, count(&conn, &f), "place 维度不一致");

        let mut f = filter();
        f.tag = Some("风景".into());
        let facet_tag: i64 = conn
            .query_row(
                &format!("SELECT count(*) {base} WHERE json_valid(c.tags) AND EXISTS (SELECT 1 FROM json_each(c.tags) WHERE json_each.value = '风景')"),
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(facet_tag, count(&conn, &f), "tag 维度不一致");
    }

    #[test]
    fn cursor_paging_covers_all_rows_without_duplicates() {
        let conn = seed();
        conn.execute_batch(
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<20000)
             INSERT INTO assets SELECT printf('x%04d', i), '/p/'||i||'.jpg',
                printf('2024-01-%02d', (i%28)+1),
                printf('2024-01-%02dT%02d:00:00', (i%28)+1, i%24), 'image', NULL FROM n;",
        )
        .unwrap();

        let total: i64 = conn
            .query_row("SELECT count(*) FROM assets", [], |r| r.get(0))
            .unwrap();
        let page = 100i64; // 20,000 行 / 100 = 200 页
        let mut cursor: Option<String> = None;
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut pages = 0;

        loop {
            let mut f = filter();
            f.limit = Some(page);
            let (mut where_sql, mut args) = filter_where(&f, true, false);
            let keyset = apply_cursor(&mut where_sql, &mut args, cursor.as_deref(), "a.taken_at");
            assert!(keyset || pages == 0, "第一页之后必须走游标");
            let sql = format!(
                "SELECT a.id, a.taken_at, a.day FROM assets a {}                  ORDER BY a.taken_at DESC, a.day DESC, a.id DESC LIMIT ?",
                where_sql
            );
            args.push(rusqlite::types::Value::Integer(page));
            let mut stmt = conn.prepare(&sql).unwrap();
            let rows: Vec<(String, String)> = stmt
                .query_map(params_from_iter(args.iter()), |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap()
                .flatten()
                .collect();
            assert!(rows.len() as i64 <= page);
            for (id, _taken) in &rows {
                assert!(seen.insert(id.clone()), "翻页出现重复行: {id}");
            }
            pages += 1;
            if (rows.len() as i64) < page {
                break;
            }
            let last = rows.last().unwrap();
            cursor = Some(format!("{}|{}", last.1, last.0));
            assert!(pages < 400, "翻页没有收敛");
        }

        assert_eq!(seen.len() as i64, total, "翻页覆盖的行数与总数不一致");
        assert!(pages >= 200, "应该翻满 200 页，实际 {pages}");
    }

    #[test]
    fn album_fold_keeps_cover_and_three_previews() {
        let rows = vec![
            ("旅行".to_string(), "a1".to_string()),
            ("旅行".to_string(), "a2".to_string()),
            ("旅行".to_string(), "a3".to_string()),
            ("旅行".to_string(), "a4".to_string()),
            ("旅行".to_string(), "a5".to_string()),
            ("家人".to_string(), "b1".to_string()),
        ];
        let out = fold_albums(rows);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].0, "旅行");
        assert_eq!(out[0].1, 5, "count 要统计全部成员");
        assert_eq!(out[0].2, vec!["a1", "a2", "a3", "a4"], "封面 + 3 张预览");
        assert_eq!(out[1].0, "家人");
        assert_eq!(out[1].2.len(), 1);
    }

    #[test]
    fn month_view_orders_by_score_and_pages_with_score_cursor() {
        // 时间线点进某个月：月内按美学分降序，翻页用 score|taken_at|id 游标。
        let conn = seed();
        conn.execute_batch("CREATE TABLE asset_quality (asset_id TEXT PRIMARY KEY, score REAL);")
            .unwrap();
        let scores = [5.0, 1.0, 9.0, 3.0, 7.0, 2.0];
        for (index, score) in scores.iter().enumerate() {
            let id = format!("s{index}");
            conn.execute(
                "INSERT INTO assets (id, path, day, taken_at, kind) VALUES (?,?,?,?,?)",
                rusqlite::params![
                    id,
                    format!("/p/{index}.jpg"),
                    "2024-01-10",
                    format!("2024-01-10T10:0{index}:00"),
                    "image"
                ],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO asset_quality VALUES (?,?)",
                rusqlite::params![format!("s{index}"), score],
            )
            .unwrap();
        }

        let mut f = filter();
        f.day_from = Some("2024-01-01".to_string());
        f.day_to = Some("2024-01-31".to_string());
        f.limit = Some(2);

        let mut seen: Vec<String> = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..4 {
            let (mut where_sql, mut args) = filter_where(&f, true, false);
            if cursor.is_some() {
                assert!(apply_score_cursor(&mut where_sql, &mut args, cursor.as_deref()));
            }
            let sql = format!(
                "SELECT a.id, a.taken_at, q.score FROM assets a                  LEFT JOIN asset_quality q ON q.asset_id = a.id {}                  ORDER BY COALESCE(q.score,-1) DESC, COALESCE(a.taken_at,'') DESC, a.id DESC LIMIT 2",
                where_sql
            );
            let mut stmt = conn.prepare(&sql).unwrap();
            let rows: Vec<(String, String, f64)> = stmt
                .query_map(params_from_iter(args.iter()), |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                })
                .unwrap()
                .flatten()
                .collect();
            if rows.is_empty() {
                break;
            }
            for (id, _taken, _score) in &rows {
                assert!(!seen.contains(id), "翻页出现重复行: {id}");
                seen.push(id.clone());
            }
            let last = rows.last().unwrap();
            cursor = Some(format!("{}|{}|{}", last.2, last.1, last.0));
        }

        assert_eq!(seen, vec!["s2", "s4", "s0", "s3", "s5", "s1"]);
    }

    #[test]
    fn month_filter_paging_covers_all_rows_in_month() {
        // 时间线点月份后走的就是这条路：day_from/day_to + 游标翻页。
        // 一个月可能超过一页（500），必须能翻完且不串到相邻月份。
        let conn = seed();
        conn.execute_batch(
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<600)
             INSERT INTO assets SELECT printf('jan%04d', i), '/p/'||i||'.jpg',
                printf('2024-01-%02d', (i%28)+1),
                printf('2024-01-%02dT%02d:00:00', (i%28)+1, i%24), 'image', NULL FROM n;
             WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<40)
             INSERT INTO assets SELECT printf('feb%04d', i), '/p/f'||i||'.jpg',
                printf('2024-02-%02d', (i%28)+1),
                printf('2024-02-%02dT%02d:00:00', (i%28)+1, i%24), 'image', NULL FROM n;",
        )
        .unwrap();

        let mut cursor: Option<String> = None;
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let page = 100i64;
        let mut pages = 0;

        loop {
            let mut f = filter();
            f.limit = Some(page);
            f.day_from = Some("2024-01-01".to_string());
            f.day_to = Some("2024-01-31".to_string());
            let (mut where_sql, mut args) = filter_where(&f, true, false);
            apply_cursor(&mut where_sql, &mut args, cursor.as_deref(), "a.taken_at");
            let sql = format!(
                "SELECT a.id, a.taken_at, a.day FROM assets a {}                  ORDER BY a.taken_at DESC, a.day DESC, a.id DESC LIMIT ?",
                where_sql
            );
            args.push(rusqlite::types::Value::Integer(page));
            let mut stmt = conn.prepare(&sql).unwrap();
            let rows: Vec<(String, String, String)> = stmt
                .query_map(params_from_iter(args.iter()), |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .unwrap()
                .flatten()
                .collect();
            assert!(!rows.is_empty(), "第 {pages} 页为空但还没翻完");
            for (id, _taken, day) in &rows {
                assert!(day.starts_with("2024-01"), "翻到了月份外的行: {id} {day}");
                assert!(seen.insert(id.clone()), "翻页出现重复行: {id}");
            }
            pages += 1;
            if (rows.len() as i64) < page {
                break;
            }
            let last = rows.last().unwrap();
            cursor = Some(format!("{}|{}", last.1, last.0));
            assert!(pages < 20, "翻页没有收敛");
        }

        let jan: i64 = conn
            .query_row("SELECT count(*) FROM assets WHERE day LIKE '2024-01%'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(seen.len() as i64, jan, "一个月内的行没有翻全");
        assert!(pages >= 6, "600 行 / 100 应至少 6 页，实际 {pages}");
    }

    /// 「当天内高分优先」：天与天之间仍按日期倒序，同一天内按分数降序。
    #[test]
    fn day_desc_quality_keeps_days_in_order_and_puts_best_photo_first() {
        let conn = seed();
        conn.execute_batch(
            "CREATE TABLE asset_quality (asset_id TEXT PRIMARY KEY, score REAL NOT NULL,
                                        stars INTEGER, model TEXT, model_version TEXT, created_at TEXT);
             -- 同一天三张：分数 3.0 / 9.0 / 6.0，排序后应是高分那张第一
             INSERT INTO assets (id, path, day, taken_at, kind) VALUES ('x1','/p/x1.jpg','2024-01-01','2024-01-01T10:00:00','image');
             INSERT INTO assets (id, path, day, taken_at, kind) VALUES ('b1','/p/b1.jpg','2024-01-01','2024-01-01T11:00:00','image');
             INSERT INTO assets (id, path, day, taken_at, kind) VALUES ('c1','/p/c1.jpg','2024-01-01','2024-01-01T12:00:00','image');
             INSERT INTO asset_quality VALUES ('x1',3.0,NULL,NULL,NULL,NULL);
             INSERT INTO asset_quality VALUES ('b1',9.0,NULL,NULL,NULL,NULL);
             INSERT INTO asset_quality VALUES ('c1',6.0,NULL,NULL,NULL,NULL);",
        )
        .unwrap();

        let sql = format!(
            "SELECT a.id, a.day, q.score FROM assets a {} WHERE a.day = '2024-01-01'{}",
            QUALITY_JOIN,
            order_clause("day_desc_quality", true, "a.taken_at")
        );
        let mut stmt = conn.prepare(&sql).unwrap();
        let rows: Vec<(String, String, f64)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .flatten()
            .collect();
        let ids: Vec<&str> = rows.iter().map(|(id, _, _)| id.as_str()).collect();
        assert_eq!(ids, vec!["b1", "c1", "x1"], "当天内应按分数降序");
        assert!(rows.windows(2).all(|w| w[0].2 >= w[1].2));

        // 换成跨两天：日期优先，高分不能把昨天的照片顶到前面
        conn.execute_batch(
            "INSERT INTO assets (id, path, day, taken_at, kind) VALUES ('z1','/p/z1.jpg','2024-01-02','2024-01-02T09:00:00','image');
             INSERT INTO assets (id, path, day, taken_at, kind) VALUES ('z2','/p/z2.jpg','2024-01-02','2024-01-02T10:00:00','image');
             INSERT INTO asset_quality VALUES ('z1',1.0,NULL,NULL,NULL,NULL);
             INSERT INTO asset_quality VALUES ('z2',0.5,NULL,NULL,NULL,NULL);",
        )
        .unwrap();
        let sql = format!(
            "SELECT a.id, a.day FROM assets a {} WHERE a.day IN ('2024-01-01','2024-01-02') AND a.id != 'a2'{}",
            QUALITY_JOIN,
            order_clause("day_desc_quality", true, "a.taken_at")
        );
        let mut stmt = conn.prepare(&sql).unwrap();
        let rows: Vec<(String, String)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .flatten()
            .collect();
        assert_eq!(rows[0].1, "2024-01-02", "日期大的天整体在前，哪怕分数很低");
        assert_eq!(rows[0].0, "z1", "同一天里 1.0 分在前");
        assert_eq!(rows[1].0, "z2", "同一天里 0.5 分排第二");
        assert!(rows[2..].iter().all(|(_, day)| day == "2024-01-01"), "第二天的低分照片不能插到前一天前面");
    }

    /// 没有 asset_quality 的库：两个新排序都要安静退回时间序，不能报错。
    #[test]
    fn quality_sorts_degrade_without_quality_table() {
        let conn = seed();
        assert!(!has_table(&conn, "asset_quality"));

        for sort in ["quality_desc", "day_desc_quality"] {
            let plan = sort_plan(sort, false, false);
            assert!(!plan.uses_score, "{sort} 在没有评分表时不该 JOIN");
            assert!(plan.offset_paging);
            let sql = format!(
                "SELECT a.id FROM assets a {} LIMIT 3",
                order_clause(sort, false, "a.taken_at")
            );
            let mut stmt = conn.prepare(&sql).unwrap();
            let ids: Vec<String> = stmt
                .query_map([], |r| r.get(0))
                .unwrap()
                .flatten()
                .collect();
            assert_eq!(ids, vec!["a3", "a2", "a1"], "{sort} 应退回时间倒序");
        }
    }

    /// 有评分表时，全局按分排序：缺分的行排在最后，同分按时间兜底。
    #[test]
    fn quality_desc_puts_unscored_rows_last() {
        let conn = seed();
        conn.execute_batch(
            "CREATE TABLE asset_quality (asset_id TEXT PRIMARY KEY, score REAL NOT NULL,
                                        stars INTEGER, model TEXT, model_version TEXT, created_at TEXT);
             INSERT INTO asset_quality VALUES ('a1',5.0,NULL,NULL,NULL,NULL);",
        )
        .unwrap();
        let sql = format!(
            "SELECT a.id FROM assets a {} {}",
            QUALITY_JOIN,
            order_clause("quality_desc", true, "a.taken_at")
        );
        let mut stmt = conn.prepare(&sql).unwrap();
        let ids: Vec<String> = stmt
            .query_map([], |r| r.get(0))
            .unwrap()
            .flatten()
            .collect();
        assert_eq!(ids[0], "a1", "有分数的排第一");
        assert!(ids[1..].iter().all(|id| id == "a3" || id == "a2"), "缺分的排最后");
    }

    #[test]
    fn sort_plan_keeps_keyset_only_for_plain_time_order() {
        // 纯时间序且有分数表：仍然走 keyset（不 JOIN），否则默认浏览会变慢。
        let plan = sort_plan("taken_desc", true, false);
        assert!(!plan.uses_score);
        assert!(!plan.offset_paging);

        // 点进某个月也保持纯时间序（不再静默按分数重排）。
        let plan = sort_plan("taken_desc", true, true);
        assert!(!plan.uses_score, "默认排序不该因为进了某个月就改成按分数");
        assert!(!plan.offset_paging);

        // 想让月内高分优先，要显式选 day_desc_quality。
        let plan = sort_plan("day_desc_quality", true, true);
        assert!(plan.uses_score);
        assert!(plan.offset_paging);

        // 没有分数表：月和全局都退回纯时间序 + keyset。
        let plan = sort_plan("taken_desc", false, true);
        assert!(!plan.uses_score);
        assert!(!plan.offset_paging);
    }

    #[test]
    fn cursor_paging_handles_identical_timestamps() {
        // 同一秒的 50 条：只看 taken_at 会漏/重复，必须靠 id 定序。
        let conn = seed();
        conn.execute_batch(
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<50)
             INSERT INTO assets SELECT printf('s%03d', i), '/p/s'||i||'.jpg', '2024-05-01',
                '2024-05-01T09:00:00', 'image', NULL FROM n;",
        )
        .unwrap();

        let total: i64 = conn.query_row("SELECT count(*) FROM assets", [], |r| r.get(0)).unwrap();
        let page = 10i64;
        let mut cursor: Option<String> = None;
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut pages = 0;

        loop {
            let mut f = filter();
            f.limit = Some(page);
            let (mut where_sql, mut args) = filter_where(&f, true, false);
            apply_cursor(&mut where_sql, &mut args, cursor.as_deref(), "a.taken_at");
            let sql = format!(
                "SELECT a.id, a.taken_at FROM assets a {}                  ORDER BY COALESCE(a.taken_at, '') DESC, a.id DESC LIMIT ?",
                where_sql
            );
            args.push(rusqlite::types::Value::Integer(page));
            let mut stmt = conn.prepare(&sql).unwrap();
            let rows: Vec<(String, String)> = stmt
                .query_map(params_from_iter(args.iter()), |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap()
                .flatten()
                .collect();
            for (id, _taken) in &rows {
                assert!(seen.insert(id.clone()), "同一秒翻页出现重复行: {id}");
            }
            pages += 1;
            if (rows.len() as i64) < page {
                break;
            }
            let last = rows.last().unwrap();
            cursor = Some(format!("{}|{}", last.1, last.0));
            assert!(pages < 100, "同一秒翻页没有收敛");
        }

        assert_eq!(seen.len() as i64, total, "同一秒数据翻页覆盖不全");
    }

    #[test]
    fn cursor_paging_never_silently_drops_null_timestamps() {
        // taken_at / day 为 NULL 的行：行值比较遇到 NULL 会整体变 NULL，
        // 不做 COALESCE 就会「没报错但少行」。这里要求翻完必须覆盖全部行。
        let conn = seed();
        conn.execute_batch(
            "ALTER TABLE assets ADD COLUMN taken_sort TEXT GENERATED ALWAYS AS (COALESCE(taken_at, '')) VIRTUAL;
             CREATE INDEX idx_assets_cursor_test ON assets(taken_sort DESC, id DESC);")
            .unwrap();
        conn.execute_batch(
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<20)
             INSERT INTO assets (id, path, day, taken_at, kind) SELECT printf('n%03d', i), '/p/n'||i||'.jpg',
                printf('2024-03-%02d', (i%28)+1),
                printf('2024-03-%02dT08:00:00', (i%28)+1), 'image' FROM n;
             INSERT INTO assets (id, path, day, taken_at, kind) VALUES
                ('z001','/p/z1.jpg', NULL, NULL, 'image'),
                ('z002','/p/z2.jpg', '2024-04-01', NULL, 'video'),
                ('z003','/p/z3.jpg', NULL, '2024-04-02T00:00:00', 'image');",
        )
        .unwrap();

        // seed() 自带 3 行，这里再加 20 + 3
        let total: i64 = conn.query_row("SELECT count(*) FROM assets", [], |r| r.get(0)).unwrap();
        assert_eq!(total, 26);

        let page = 5i64;
        let mut cursor: Option<String> = None;
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut pages = 0;

        loop {
            let mut f = filter();
            f.limit = Some(page);
            let (mut where_sql, mut args) = filter_where(&f, true, false);
            apply_cursor(&mut where_sql, &mut args, cursor.as_deref(), "a.taken_sort");
            let sql = format!(
                "SELECT a.id, a.taken_sort FROM assets a {}                  ORDER BY a.taken_sort DESC, a.id DESC LIMIT ?",
                where_sql
            );
            args.push(rusqlite::types::Value::Integer(page));
            let mut stmt = conn.prepare(&sql).unwrap();
            let rows: Vec<(String, String)> = stmt
                .query_map(params_from_iter(args.iter()), |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap()
                .flatten()
                .collect();
            for (id, _taken) in &rows {
                assert!(seen.insert(id.clone()), "翻页出现重复行: {id}");
            }
            pages += 1;
            if (rows.len() as i64) < page {
                break;
            }
            let last = rows.last().unwrap();
            cursor = Some(format!("{}|{}", last.1, last.0));
            assert!(pages < 100, "含 NULL 的翻页没有收敛");
        }

        assert_eq!(
            seen.len() as i64,
            total,
            "含 NULL taken_at 的库翻页后少了 {} 行（静默丢行）",
            total - seen.len() as i64
        );
        assert!(seen.contains("z001") && seen.contains("z002") && seen.contains("z003"));
    }
}

#[cfg(all(test, target_os = "macos"))]
mod trash_tests {
    use super::trash_with;

    /// 移到废纸篓后，原路径上就不该再有这个文件（内容还在废纸篓里）。
    /// 与 delete_records 相同的移废纸篓实现：外部盘上的文件（/Volumes）也要能成功。
    #[test]
    fn moves_external_volume_file_into_trash() {
        let root = std::path::Path::new("/Volumes/Leng/_sgcheck");
        if !root.parent().map(|p| p.exists()).unwrap_or(false) {
            eprintln!("skip: 外置盘 /Volumes/Leng 不存在");
            return;
        }
        std::fs::create_dir_all(root).unwrap();
        let name = format!("trash-probe-{}.txt", std::process::id());
        let file = root.join(&name);
        std::fs::write(&file, b"probe").unwrap();
        trash_with(&file).expect("外置盘文件移到废纸篓失败");
        assert!(!file.exists(), "原路径应已不存在");
        // 自测不往真实废纸篓里留垃圾：移进去的文件按同名清掉。
        let _ = std::fs::remove_file(std::path::Path::new("/Volumes/Leng/.Trashes/501").join(&name));
    }

    #[test]
    fn moves_file_into_trash() {

        let dir = std::env::temp_dir().join(format!("sg-trash-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("sample.txt");
        std::fs::write(&file, b"hello").unwrap();
        trash_with(&file).expect("移到废纸篓失败");
        assert!(!file.exists(), "原路径应已不存在");
        let _ = std::fs::remove_dir(&dir);
    }
}

#[cfg(test)]
mod dup_tests {
    use super::*;

    fn seed() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE assets (id TEXT PRIMARY KEY, deleted_at TEXT);
             CREATE TABLE dup_groups (id INTEGER PRIMARY KEY, keeper_id TEXT, reason TEXT, created_at TEXT);
             CREATE TABLE dup_members (group_id INTEGER, asset_id TEXT, distance INTEGER,
                                       PRIMARY KEY (group_id, asset_id));
             INSERT INTO assets VALUES ('a1',NULL);
             INSERT INTO assets VALUES ('a2',NULL);
             INSERT INTO assets VALUES ('a3',NULL);
             INSERT INTO assets VALUES ('b1',NULL);
             INSERT INTO assets VALUES ('b2',NULL);
             INSERT INTO dup_groups VALUES (1,'a2','l0+l1','2026-01-01');
             INSERT INTO dup_groups VALUES (2,'b1','burst','2026-01-01');
             INSERT INTO dup_members VALUES (1,'a2',0);
             INSERT INTO dup_members VALUES (1,'a1',3);
             INSERT INTO dup_members VALUES (1,'a3',NULL);
             INSERT INTO dup_members VALUES (2,'b1',0);
             INSERT INTO dup_members VALUES (2,'b2',1);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn missing_tables_return_empty() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE assets (id TEXT)").unwrap();
        assert!(read_dup_groups(&conn).unwrap().is_empty());
    }

    #[test]
    fn groups_are_read_back_in_full() {
        let conn = seed();
        let groups = read_dup_groups(&conn).unwrap();
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].id, 1);
        assert_eq!(groups[0].keeper_id, "a2");
        assert_eq!(groups[0].reason, "l0+l1");
        assert_eq!(groups[0].count, 3);
        assert_eq!(groups[0].members.len(), 3);
        assert_eq!(groups[0].members[0].asset_id, "a2");
        assert_eq!(groups[0].members[1].distance, Some(3));
        assert_eq!(groups[0].members[2].distance, None);
        assert!(groups
            .iter()
            .all(|group| group.members.iter().any(|member| member.asset_id == group.keeper_id)));
    }
}


/// 删除失败时把“没有权限”单独认出来：macOS 对没声明用途说明的目录（外置盘等）
/// 不会弹授权框，只会返回 EPERM，得把它转成能照着做的提示。
fn permission_hint(errors: &[String]) -> Option<String> {
    const DENIED: [&str; 4] = [
        "Operation not permitted",
        "permission",
        "Permission",
        "NSPOSIXErrorDomain Code=1",
    ];
    let blocked = errors
        .iter()
        .filter(|e| DENIED.iter().any(|word| e.contains(word)))
        .count();
    if blocked == 0 {
        return None;
    }
    Some(format!(
        "没有权限移动这 {blocked} 个原图（文件在受保护的磁盘目录里）。请在「系统设置 → 隐私与安全性」里给拾光打开该磁盘的访问权限，或开启「完全磁盘访问权限」后重启拾光。"
    ))
}

/// 库里记录的资产分散在哪些顶层目录（/Volumes/X、/Users/xxx），各有多少条。
/// 授权检查按它给出的照片为准：只看目录能不能读，会漏掉“目录能进、照片打不开”。
fn library_roots(conn: &Connection) -> Vec<(String, usize)> {
    let mut roots: Vec<(String, usize)> = Vec::new();
    let Ok(mut stmt) = conn.prepare("SELECT path FROM assets") else {
        return roots;
    };
    let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(0)) else {
        return roots;
    };
    for path in rows.filter_map(Result::ok) {
        let root = if let Some(rest) = path.strip_prefix("/Volumes/") {
            match rest.split('/').next() {
                Some(volume) if !volume.is_empty() => format!("/Volumes/{volume}"),
                _ => continue,
            }
        } else if let Some(user) = path.strip_prefix("/Users/").and_then(|rest| rest.split('/').next())
        {
            match user {
                "" => continue,
                user => format!("/Users/{user}"),
            }
        } else {
            continue;
        };
        match roots.iter_mut().find(|(known, _)| known == &root) {
            Some((_, count)) => *count += 1,
            None => roots.push((root, 1)),
        }
    }
    roots
}

/// 挑该目录下（按路径序）的前几张，逐个确认能不能打开。
/// 被 TCC 拒绝时 open 报 EPERM；文件已经不在（ENOENT）不算授权问题。
fn can_read_sample<S: Iterator<Item = String>>(paths: S, limit: usize) -> bool {
    let mut probed = 0;
    for path in paths {
        if probed >= limit {
            break;
        }
        match std::fs::File::open(&path) {
            Ok(_) => probed += 1,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return false,
        }
    }
    true
}

#[derive(serde::Serialize)]
pub struct AccessRoot {
    root: String,
    exists: bool,
    readable: bool,
    assets: usize,
}

fn access_report(conn: &Connection) -> Vec<AccessRoot> {
    const SAMPLES: usize = 3;
    let mut report = Vec::new();
    for (root, assets) in library_roots(conn) {
        let dir = std::path::PathBuf::from(&root);
        let exists = dir.exists();
        let readable = if !exists || std::fs::read_dir(&dir).is_err() {
            false
        } else {
            let mut stmt = match conn
                .prepare("SELECT path FROM assets WHERE path LIKE ?1 ORDER BY path LIMIT ?2")
            {
                Ok(stmt) => stmt,
                Err(_) => {
                    report.push(AccessRoot { root, exists, readable: true, assets });
                    continue;
                }
            };
            let prefix = format!("{root}/%");
            match stmt.query_map(params_from_iter([prefix.as_str(), &SAMPLES.to_string()]), |row| row.get::<_, String>(0)) {
                Ok(paths) => can_read_sample(paths.filter_map(Result::ok), SAMPLES),
                Err(_) => true,
            }
        };
        report.push(AccessRoot { root, exists, readable, assets });
    }
    report
}

#[tauri::command]
fn library_access(db: State<'_, Db>) -> Result<serde_json::Value, String> {
    let guard = db.open()?;
    let conn = guard.as_ref().unwrap();
    Ok(serde_json::json!({ "roots": access_report(conn) }))
}

#[tauri::command]
fn open_privacy_settings() -> Result<(), String> {
    std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles")
        .status()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// 命令行诊断入口：返回当前会使用的 Python 解释器。
pub fn python_report_for(home: &Path) -> String {
    py::report_string(home)
}

/// 命令行诊断入口用：按数据目录里的库算一份授权检查结果。
pub fn access_report_for(data_dir: &Path) -> Vec<AccessRoot> {
    match Connection::open(data_dir.join("lifelog.sqlite")) {
        Ok(conn) => access_report(&conn),
        Err(_) => Vec::new(),
    }
}

/// CLI 的进度行用 phase 标记阶段，前端读的是 stage。
/// 这个转换曾经漏过：事件发出去了但进度数字不动，所以单独抽出来测。
fn normalize_ingest_event(value: &mut serde_json::Value) -> bool {
    if value.get("phase").and_then(|v| v.as_str()) != Some("ingest") {
        return false;
    }
    if let Some(map) = value.as_object_mut() {
        map.insert("stage".to_string(), serde_json::json!("ingest"));
    }
    true
}

#[cfg(test)]
mod library_tests {
    use super::*;

    #[test]
    fn library_ready_requires_sqlite_file() {
        let dir = std::env::temp_dir().join(format!("sg-lib-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!library_ready(&dir), "空目录不算就绪");
        std::fs::write(dir.join("lifelog.sqlite"), b"").unwrap();
        assert!(library_ready(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn config_roundtrip_remembers_library() {
        // 不碰真实配置：直接验证写/读 JSON 的逻辑。
        let dir = std::env::temp_dir().join(format!("sg-cfg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("library.json");
        let body = serde_json::json!({ "data_dir": "/tmp/photos-library" });
        std::fs::write(&path, body.to_string()).unwrap();
        let raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(raw["data_dir"], "/tmp/photos-library");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
#[cfg(test)]
mod ingest_event_tests {
    use super::normalize_ingest_event;

    #[test]
    fn ingest_line_gains_stage_so_frontend_updates() {
        let mut value = serde_json::json!({
            "phase": "ingest", "seen": 600, "new": 590, "skipped": 10
        });
        assert!(normalize_ingest_event(&mut value));
        assert_eq!(value["stage"], "ingest");
        assert_eq!(value["seen"], 600);
    }

    #[test]
    fn other_phase_is_ignored() {
        let mut value = serde_json::json!({ "phase": "hash", "done": 1 });
        assert!(!normalize_ingest_event(&mut value));
        assert!(value.get("stage").is_none());
    }
}

/// 跑一次 ingest，边读 stderr 边回调事件（与 import_folder 完全同一条代码路径）。
/// 抽出来是为了让验收脚本能用同一份逻辑，而不是另写一份可能再次跑偏的模拟。
fn stream_ingest_events<F>(python: &Path, root: &Path, home: &Path, folder: &str, mut on_event: F)
    -> Result<serde_json::Value, String>
where
    F: FnMut(serde_json::Value),
{
    let mut child = std::process::Command::new(python)
        .arg("-c")
        .arg("from lifelog.cli import main; main()")
        .arg("ingest")
        .arg(folder)
        .arg("--progress")
        .current_dir(root)
        .env("PYTHONPATH", root)
        .env("LIFELOG_HOME", home)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("启动导入失败：{err}"))?;

    // stderr 与 stdout 必须同时读，否则任一管道写满 64KB 就会互相等死。
    let stderr = child.stderr.take();
    let reader = std::thread::spawn(move || {
        let mut lines = Vec::new();
        if let Some(pipe) = stderr {
            for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                lines.push(line);
            }
        }
        lines
    });

    let mut stdout = String::new();
    if let Some(mut pipe) = child.stdout.take() {
        let _ = pipe.read_to_string(&mut stdout);
    }
    let stderr_lines = reader.join().unwrap_or_default();
    let status = child.wait().map_err(|err| format!("导入进程失败：{err}"))?;

    for line in stderr_lines {
        if let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&line) {
            if normalize_ingest_event(&mut value) {
                on_event(value);
            }
        }
    }
    if !status.success() {
        return Err(format!("导入失败：{}", stdout.trim()));
    }
    Ok(serde_json::from_str(stdout.trim()).unwrap_or(serde_json::Value::Null))
}

/// 验收用：跑真实 ingest，把每一步事件按行打到 stdout（与桌面端 emit 的内容一致）。
pub fn ingest_probe(folder: &str) -> Result<Vec<String>, String> {
    let home = PathBuf::from(std::env::var("LIFELOG_HOME").unwrap_or_else(|_| {
        format!(
            "{}/dev/lifelog-minicpm/data",
            std::env::var("HOME").unwrap_or_default()
        )
    }));
    let root = repo_root();
    let python = py::resolve(&home)?;
    let mut events = Vec::new();
    let stats = stream_ingest_events(&python, &root, &home, folder, |value| {
        events.push(value.to_string());
    })?;
    events.push(serde_json::json!({"stage": "ingest-done", "stats": stats}).to_string());
    Ok(events)
}
