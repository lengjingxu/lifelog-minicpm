use rusqlite::{params_from_iter, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter, Manager, State};

mod export;

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
    let mut stmt = conn
        .prepare(
            "WITH months AS (                  SELECT substr(day, 1, 7) AS m, count(*) AS n FROM assets WHERE day IS NOT NULL GROUP BY m)              SELECT m, n, (                  SELECT a2.id FROM assets a2 WHERE a2.day >= m || '-01'                    AND a2.day < date(m || '-01', '+1 month')                  ORDER BY a2.taken_at DESC, a2.id DESC LIMIT 1) AS cover              FROM months ORDER BY m DESC",
        )
        .map_err(|e| e.to_string())?;
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
    let mut stmt = conn
        .prepare(
            "SELECT a.id, c.tags, c.scene, c.people, c.place FROM assets a              LEFT JOIN captions c ON c.rowid = (                  SELECT rowid FROM captions c2 WHERE c2.asset_id = a.id ORDER BY c2.created_at DESC LIMIT 1)              ORDER BY a.taken_at DESC, a.id DESC",
        )
        .map_err(|e| e.to_string())?;
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
    user_tags: Vec<(String, i64)>,
    albums: Vec<(String, i64)>,
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

fn filter_where(filter: &Filter, has_asset_tags: bool) -> (String, Vec<rusqlite::types::Value>) {
    let mut sql = String::from(" WHERE 1=1");
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
    push(filter.day_from.as_deref(), " AND a.day >= ?{n}", &mut args, &mut sql);
    push(filter.day_to.as_deref(), " AND a.day <= ?{n}", &mut args, &mut sql);

    (sql, args)
}

#[tauri::command]
fn count_assets(db: State<'_, Db>, filter: Filter) -> Result<i64, String> {
    let guard = db.open()?;
    let conn = guard.as_ref().unwrap();
    let (where_sql, args) = filter_where(&filter, has_table(conn, "asset_tags"));
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

#[tauri::command]
fn query_assets(db: State<'_, Db>, filter: Filter) -> Result<Vec<AssetRow>, String> {
    let guard = db.open()?;
    let conn = guard.as_ref().unwrap();
    let (mut where_sql, mut args) = filter_where(&filter, has_table(conn, "asset_tags"));
    let has_sort = has_column(conn, "assets", "taken_sort");
    if filter.cursor.as_deref().map(str::trim).is_some_and(|c| !c.is_empty()) && !has_sort {
        return Err("数据库缺少 taken_sort 列，请先运行一次 lifelog CLI 升级索引".to_string());
    }
    let key_col = if has_sort { "a.taken_sort" } else { "a.taken_at" };
    let keyset = apply_cursor(&mut where_sql, &mut args, filter.cursor.as_deref(), key_col);
    let mut sql = format!(
        "SELECT a.id, a.path, a.day, a.taken_at, a.kind, \
                c.caption, c.scene, c.people, c.place, c.activity, c.mood, c.tags, c.ocr_text \
         FROM assets a \
         LEFT JOIN captions c ON c.rowid = ( \
             SELECT rowid FROM captions c2 WHERE c2.asset_id = a.id ORDER BY c2.created_at DESC LIMIT 1) \
         {}",
        where_sql
    );


    // 游标是 (taken_sort, id) 二元组：同一秒的多条靠 id 分先后，翻页才是严格全序。
    sql.push_str(&format!(" ORDER BY {key_col} DESC, a.id DESC LIMIT ?"));
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

    // 按「每个 asset 的最新一条 caption」统计，与 query_assets / count_assets 同源，
    // 否则分类卡片的数字（按 caption 行计）会和网格总数（按 asset 计）对不上。
    let mut stmt = conn
        .prepare(
            "SELECT c.tags, c.scene, c.people FROM assets a \
             LEFT JOIN captions c ON c.rowid = ( \
                 SELECT rowid FROM captions c2 WHERE c2.asset_id = a.id ORDER BY c2.created_at DESC LIMIT 1)",
        )
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
        .prepare("SELECT substr(day,1,7) AS m, count(*) FROM assets WHERE day IS NOT NULL GROUP BY m ORDER BY m DESC")
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
            (format!(" WHERE a.id IN ({placeholders})"), values)
        }
        (_, Some(filter)) => filter_where(filter, has_table(conn, "asset_tags")),
        _ => (String::from(" WHERE 1=1"), Vec::new()),
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

#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    std::process::Command::new("open")
        .arg("-R")
        .arg(path)
        .status()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_records(db: State<'_, Db>, ids: Vec<String>) -> Result<serde_json::Value, String> {
    let home = db.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let ids: Vec<String> = ids.into_iter().filter(|id| !id.trim().is_empty()).collect();
        if ids.is_empty() {
            return Err("没有选中要移除的记录".to_string());
        }
        let result = run_python_cli(&home, &["record-delete".to_string(), "--ids".to_string(), ids.join(",")])?;
        // 记录没了，缩略图缓存就成了孤儿，顺手清掉（只动缓存，不动原图）。
        let _ = run_python_cli(
            &home,
            &["thumbs-prune".to_string(), "--ids".to_string(), ids.join(",")],
        );
        Ok(result)
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
        let output = Command::new("python3")
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
        .query_row("SELECT count(*) FROM assets", [], |row| row.get(0))
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
        let mut command = std::process::Command::new("python3");
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
fn run_python_cli(home: &Path, args: &[String]) -> Result<serde_json::Value, String> {
    let root = desktop_root();
    let output = std::process::Command::new("python3")
        .arg("-c")
        .arg("from lifelog.cli import main; main()")
        .args(args)
        .current_dir(&root)
        .env("PYTHONPATH", &root)
        .env("LIFELOG_HOME", home)
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
        let root = desktop_root();
        let _ = app.emit("import-progress", serde_json::json!({"stage": "ingest", "message": "正在扫描文件夹"}));
        let output = std::process::Command::new("python3")
            .arg("-c")
            .arg("from lifelog.cli import main; main()")
            .arg("ingest")
            .arg(&path)
            .current_dir(&root)
            .env("PYTHONPATH", &root)
            .env("LIFELOG_HOME", &home)
            .output()
            .map_err(|err| format!("启动导入失败：{err}"))?;
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        if !output.status.success() {
            let _ = app.emit("import-progress", serde_json::json!({"stage": "failed", "message": stderr.trim()}));
            return Ok(serde_json::json!({"ok": false, "stderr": stderr.trim(), "stdout": stdout.trim()}));
        }
        let stats: serde_json::Value = serde_json::from_str(stdout.trim()).unwrap_or(serde_json::Value::Null);
        let _ = app.emit("import-progress", serde_json::json!({"stage": "ingest-done", "stats": stats}));

        // 导入完成后自动补齐缩略图
        let script = root.join("scripts/gen_thumbs.py");
        if script.exists() {
            let _ = app.emit("import-progress", serde_json::json!({"stage": "thumbs", "message": "正在生成缩略图"}));
            if let Ok(mut child) = std::process::Command::new("python3")
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
        .plugin(tauri_plugin_dialog::init())
        .manage(Db {
            path: db_path,
            data_dir,
            conn: Mutex::new(None),
        })
        .manage(sidecar)
        .invoke_handler(tauri::generate_handler![
            library_stats,
            query_assets,
            count_assets,
            export_assets,
            import_xiaomi,
            delete_records,
            reveal_in_finder,
            facets,
            timeline_months,
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
            "CREATE TABLE assets (id TEXT PRIMARY KEY, path TEXT, day TEXT, taken_at TEXT, kind TEXT);
             CREATE TABLE captions (rowid INTEGER PRIMARY KEY, asset_id TEXT, caption TEXT, scene TEXT,
                                    people TEXT, place TEXT, activity TEXT, mood TEXT, tags TEXT,
                                    ocr_text TEXT, created_at TEXT);
             CREATE TABLE asset_tags (asset_id TEXT, tag TEXT, created_at TEXT);
             CREATE TABLE albums (id TEXT PRIMARY KEY, name TEXT, created_at TEXT);
             CREATE TABLE album_assets (album_id TEXT, asset_id TEXT, added_at TEXT);
             INSERT INTO assets VALUES ('a1','/p/1.jpg','2024-01-01','2024-01-01T10:00:00','image');
             INSERT INTO assets VALUES ('a2','/p/2.jpg','2024-01-02','2024-01-02T10:00:00','image');
             INSERT INTO assets VALUES ('a3','/p/3.jpg','2024-01-03','2024-01-03T10:00:00','image');
             INSERT INTO captions VALUES (1,'a1','海边日落','户外','一人','海边','休息','平静','[\"风景\"]',NULL,'2024-01-01');
             INSERT INTO captions VALUES (2,'a2','山间徒步','户外','一人','山里','行走','平静','[\"风景\"]',NULL,'2024-01-02');
             INSERT INTO captions VALUES (3,'a3','室内看书','室内居家','多人','家','阅读','安静','[\"人物\"]',NULL,'2024-01-03');",
        )
        .unwrap();
        conn
    }

    fn count(conn: &rusqlite::Connection, filter: &Filter) -> i64 {
        let (where_sql, args) = filter_where(filter, true);
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
        let (where_sql, mut args) = filter_where(filter, true);
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
                printf('2024-01-%02dT%02d:00:00', (i%28)+1, i%24), 'image' FROM n;",
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
            let (mut where_sql, mut args) = filter_where(&f, true);
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
    fn cursor_paging_handles_identical_timestamps() {
        // 同一秒的 50 条：只看 taken_at 会漏/重复，必须靠 id 定序。
        let conn = seed();
        conn.execute_batch(
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<50)
             INSERT INTO assets SELECT printf('s%03d', i), '/p/s'||i||'.jpg', '2024-05-01',
                '2024-05-01T09:00:00', 'image' FROM n;",
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
            let (mut where_sql, mut args) = filter_where(&f, true);
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
             INSERT INTO assets SELECT printf('n%03d', i), '/p/n'||i||'.jpg',
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
            let (mut where_sql, mut args) = filter_where(&f, true);
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
