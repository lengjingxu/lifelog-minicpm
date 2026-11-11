use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::UNIX_EPOCH;

/// 文件名净化：去掉路径分隔符、冒号、控制字符，截到 200 字符（保留扩展名）。
pub fn sanitize_name(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| match c {
            '/' | ':' | '\\' | '\0' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.');
    let candidate = if trimmed.is_empty() { "untitled" } else { trimmed };
    if candidate.chars().count() <= 200 {
        return candidate.to_string();
    }
    let path = Path::new(candidate);
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let stem: String = path.file_stem().and_then(|s| s.to_str()).unwrap_or("file").chars().take(180).collect();
    if ext.is_empty() { stem } else { format!("{stem}.{ext}") }
}

/// 冲突文件名：{日期}_{id 前 6}_{原名}；若仍冲突，追加 -2/-3…
pub fn conflict_name(original: &str, day: Option<&str>, id: &str) -> String {
    let clean = sanitize_name(original);
    let date = day.unwrap_or("0000-00-00");
    let short: String = id.chars().take(6).collect();
    format!("{date}_{short}_{clean}")
}

pub fn with_suffix(name: &str, n: usize) -> String {
    if n <= 1 {
        return name.to_string();
    }
    let path = Path::new(name);
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
    if ext.is_empty() { format!("{stem}-{n}") } else { format!("{stem}-{n}.{ext}") }
}

fn same_file(a: &Path, b: &Path) -> bool {
    let (Ok(ma), Ok(mb)) = (fs::metadata(a), fs::metadata(b)) else { return false };
    if ma.len() != mb.len() { return false; }
    let ta = ma.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs());
    let tb = mb.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs());
    ta == tb
}

/// 目标盘可用字节（df -Pk，macOS/Linux 通用）
pub fn free_bytes(dir: &Path) -> u64 {
    let out = Command::new("df").arg("-Pk").arg(dir).output();
    let Ok(out) = out else { return 0 };
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().nth(1).unwrap_or("");
    let cols: Vec<&str> = line.split_whitespace().collect();
    cols.get(3).and_then(|v| v.parse::<u64>().ok()).map(|kb| kb * 1024).unwrap_or(0)
}

/// 目标目录是否落在库目录内部（避免导出再被扫描入库）。
pub fn inside_library(target: &Path, home: &Path) -> bool {
    let t = fs::canonicalize(target).unwrap_or_else(|_| target.to_path_buf());
    let h = fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf());
    t.starts_with(&h)
}

#[derive(Serialize, Debug)]
pub struct ExportItem {
    pub id: String,
    pub source: String,
    pub target: String,
    pub status: String, // copied | skipped-identical | failed
    pub error: Option<String>,
}

#[derive(Serialize, Debug)]
pub struct ExportSummary {
    pub ok: bool,
    pub total: usize,
    pub copied: usize,
    pub skipped: usize,
    pub failed: usize,
    pub manifest: String,
    pub target: String,
}


pub enum Dest {
    Copy(PathBuf),
    Skip(PathBuf),
}

/// 决定目标路径：原名 → 冲突名 → -2/-3…；超过上限返回错误，绝不覆盖已有文件。
pub fn resolve_dest(target: &Path, src: &Path, row: &Row, limit: usize) -> Result<Dest, String> {
    let original_name = src.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let first = target.join(sanitize_name(original_name));
    if !first.exists() {
        return Ok(Dest::Copy(first));
    }
    if same_file(src, &first) {
        return Ok(Dest::Skip(first));
    }

    let base = conflict_name(original_name, row.day.as_deref(), &row.id);
    let candidate = target.join(&base);
    if !candidate.exists() {
        return Ok(Dest::Copy(candidate));
    }

    for n in 2..=limit {
        let path = target.join(with_suffix(&base, n));
        if !path.exists() {
            return Ok(Dest::Copy(path));
        }
    }
    Err(format!("同名冲突超过上限（{limit}），未覆盖任何文件"))
}

pub fn write_sidecar(dest: &Path, row: &Row) {
    let sidecar = PathBuf::from(format!("{}.json", dest.to_string_lossy()));
    if sidecar.exists() {
        return;
    }
    let payload = json!({
        "id": row.id,
        "source": row.path,
        "day": row.day,
        "taken_at": row.taken_at,
        "caption": row.caption,
        "scene": row.scene,
        "people": row.people,
        "place": row.place,
        "activity": row.activity,
        "mood": row.mood,
        "tags": row.tags,
        "ocr_text": row.ocr_text,
    });
    let _ = fs::write(sidecar, serde_json::to_vec_pretty(&payload).unwrap_or_default());
}

pub struct Row {
    pub id: String,
    pub path: String,
    pub day: Option<String>,
    pub taken_at: Option<String>,
    pub caption: Option<String>,
    pub scene: Option<String>,
    pub people: Option<String>,
    pub place: Option<String>,
    pub activity: Option<String>,
    pub mood: Option<String>,
    pub tags: Vec<String>,
    pub ocr_text: Option<String>,
}

pub fn export_rows(rows: &[Row], home: &Path, target: &Path) -> Result<ExportSummary, String> {
    if inside_library(target, home) {
        return Err(format!("目标目录在库内部（{}），会导出后再次被扫描，已拒绝", target.display()));
    }

    let mut needed: u64 = 0;
    for row in rows {
        let src = if Path::new(&row.path).is_absolute() { PathBuf::from(&row.path) } else { home.join(&row.path) };
        if let Ok(meta) = fs::metadata(&src) {
            needed += meta.len();
        }
    }
    let free = free_bytes(target);
    if free == 0 {
        return Err("无法读取目标盘可用空间，已拒绝导出".to_string());
    }
    if needed > free {
        return Err(format!(
            "空间不足：需要 {:.1} GB，可用 {:.1} GB",
            needed as f64 / 1e9,
            free as f64 / 1e9
        ));
    }

    let mut items: Vec<ExportItem> = Vec::new();
    let mut copied = 0;
    let mut skipped = 0;
    let mut failed = 0;

    for row in rows {
        let src = if Path::new(&row.path).is_absolute() { PathBuf::from(&row.path) } else { home.join(&row.path) };
        let original_name = src.file_name().and_then(|n| n.to_str()).unwrap_or("file");
        let dest = match resolve_dest(target, &src, row, 200) {
            Ok(Dest::Skip(existing)) => {
                skipped += 1;
                // 原图已一致，但 sidecar 可能被用户删过：补写一份，不复制原图。
                write_sidecar(&existing, row);
                items.push(ExportItem {
                    id: row.id.clone(),
                    source: src.to_string_lossy().to_string(),
                    target: existing.to_string_lossy().to_string(),
                    status: "skipped-identical".into(),
                    error: None,
                });
                continue;
            }
            Ok(Dest::Copy(path)) => path,
            Err(reason) => {
                failed += 1;
                items.push(ExportItem {
                    id: row.id.clone(),
                    source: src.to_string_lossy().to_string(),
                    target: String::new(),
                    status: "failed".into(),
                    error: Some(reason),
                });
                continue;
            }
        };

        match fs::copy(&src, &dest) {
            Ok(_) => {
                copied += 1;
                write_sidecar(&dest, row);
                items.push(ExportItem {
                    id: row.id.clone(),
                    source: src.to_string_lossy().to_string(),
                    target: dest.to_string_lossy().to_string(),
                    status: "copied".into(),
                    error: None,
                });
            }
            Err(err) => {
                failed += 1;
                items.push(ExportItem {
                    id: row.id.clone(),
                    source: src.to_string_lossy().to_string(),
                    target: dest.to_string_lossy().to_string(),
                    status: "failed".into(),
                    error: Some(err.to_string()),
                });
            }
        }
    }

    let stamp = chrono_like_stamp();
    let manifest_path = target.join(format!("manifest-{stamp}.json"));
    let manifest = json!({
        "exported_at": stamp,
        "target": target.to_string_lossy(),
        "counts": {
            "total": rows.len(),
            "copied": copied,
            "skipped_identical": skipped,
            "failed": failed,
        },
        "items": items.iter().map(|i| json!({
            "id": i.id, "source": i.source, "target": i.target,
            "status": i.status, "error": i.error,
        })).collect::<Vec<_>>(),
    });
    fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest).unwrap_or_default())
        .map_err(|e| format!("写入 manifest 失败：{e}"))?;

    Ok(ExportSummary {
        ok: failed == 0,
        total: rows.len(),
        copied,
        skipped,
        failed,
        manifest: manifest_path.to_string_lossy().to_string(),
        target: target.to_string_lossy().to_string(),
    })
}

fn chrono_like_stamp() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{now}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_strips_separators_and_control_chars() {
        assert_eq!(sanitize_name("a/b:c\\nd.jpg"), "a_b_c_nd.jpg");
        assert!(sanitize_name(&"x".repeat(300)).chars().count() <= 200);
    }

    #[test]
    fn conflict_name_uses_day_and_short_id() {
        assert_eq!(conflict_name("IMG_1.jpg", Some("2024-02-09"), "abcdef123456"), "2024-02-09_abcdef_IMG_1.jpg");
    }

    #[test]
    fn suffix_keeps_extension() {
        assert_eq!(with_suffix("a.jpg", 2), "a-2.jpg");
        assert_eq!(with_suffix("a", 2), "a-2");
    }

    fn tmpdir(tag: &str) -> std::path::PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!("sg-export-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn seed_rows(home: &Path, count: usize) -> Vec<Row> {
        let photos = home.join("photos");
        fs::create_dir_all(&photos).unwrap();
        (0..count)
            .map(|i| {
                let path = photos.join(format!("IMG_{i}.jpg"));
                fs::write(&path, format!("content-{i}")).unwrap();
                Row {
                    id: format!("id{i:06}"),
                    path: path.to_string_lossy().to_string(),
                    day: Some("2024-02-09".into()),
                    taken_at: Some("2024-02-09T10:00:00".into()),
                    caption: Some("测试描述".into()),
                    scene: Some("户外".into()),
                    people: Some("一人".into()),
                    place: Some("海边".into()),
                    activity: Some("休息".into()),
                    mood: Some("平静".into()),
                    tags: vec!["风景".into()],
                    ocr_text: None,
                }
            })
            .collect()
    }

    #[test]
    fn rejects_target_inside_library() {
        let home = tmpdir("home");
        let rows = seed_rows(&home, 1);
        let inside = home.join("export");
        fs::create_dir_all(&inside).unwrap();
        let err = export_rows(&rows, &home, &inside).unwrap_err();
        assert!(err.contains("库内部"));
    }

    #[test]
    fn copies_writes_sidecar_and_manifest_then_skips_identical() {
        let home = tmpdir("src");
        let target = tmpdir("dst");
        let rows = seed_rows(&home, 2);

        let first = export_rows(&rows, &home, &target).unwrap();
        assert_eq!(first.copied, 2);
        assert_eq!(first.skipped, 0);
        assert_eq!(first.failed, 0);
        assert!(Path::new(&first.manifest).exists());
        assert!(target.join("IMG_0.jpg.json").exists(), "sidecar 应为 {{原名}}.json");

        let second = export_rows(&rows, &home, &target).unwrap();
        assert_eq!(second.copied, 0);
        assert_eq!(second.skipped, 2, "第二次应全部 skipped-identical");
        let manifest: Value = serde_json::from_slice(&fs::read(&second.manifest).unwrap()).unwrap();
        let statuses: Vec<&str> = manifest["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["status"].as_str().unwrap())
            .collect();
        assert!(statuses.iter().all(|s| *s == "skipped-identical"));
        assert_eq!(manifest["counts"]["skipped_identical"], 2);
    }

    #[test]
    fn name_conflict_uses_date_and_short_id() {
        let home = tmpdir("src2");
        let target = tmpdir("dst2");
        let rows = seed_rows(&home, 1);
        // 目标目录里先放一个同名但内容不同的文件
        fs::write(target.join("IMG_0.jpg"), "different-content-that-is-longer").unwrap();

        let summary = export_rows(&rows, &home, &target).unwrap();
        assert_eq!(summary.copied, 1);
        let renamed = target.join("2024-02-09_id0000_IMG_0.jpg");
        assert!(renamed.exists(), "冲突时应退化为 日期_id_原名");
        assert!(fs::read_to_string(&renamed).unwrap().starts_with("content-"));
        assert_eq!(fs::read_to_string(target.join("IMG_0.jpg")).unwrap(), "different-content-that-is-longer");
    }

    #[test]
    fn conflict_exhaustion_fails_instead_of_overwriting() {
        let home = tmpdir("src3");
        let target = tmpdir("dst3");
        let rows = seed_rows(&home, 1);
        fs::write(target.join("IMG_0.jpg"), "someone-elses-file").unwrap();
        let base = "2024-02-09_id0000_IMG_0.jpg";
        fs::write(target.join(&base), "x").unwrap();
        fs::write(target.join("2024-02-09_id0000_IMG_0-2.jpg"), "x").unwrap();

        // limit=2 表示只允许 -2，故意让它用尽
        let outcome = resolve_dest(&target, Path::new(&rows[0].path), &rows[0], 2);
        assert!(matches!(outcome, Err(ref e) if e.contains("同名冲突超过上限")));
        assert_eq!(fs::read_to_string(target.join("IMG_0.jpg")).unwrap(), "someone-elses-file");
    }

    #[test]
    fn unreadable_target_space_is_fail_closed() {
        let home = tmpdir("src4");
        let rows = seed_rows(&home, 1);
        let missing = home.join("no-such-target");
        let err = export_rows(&rows, &home, &missing).unwrap_err();
        assert!(err.contains("无法读取目标盘可用空间"), "实际：{err}");
    }

    #[test]
    fn skipped_identical_writes_missing_sidecar() {
        let home = tmpdir("src5");
        let target = tmpdir("dst5");
        let rows = seed_rows(&home, 1);
        let _ = export_rows(&rows, &home, &target).unwrap();
        let sidecar = target.join("IMG_0.jpg.json");
        assert!(sidecar.exists());
        fs::remove_file(&sidecar).unwrap();
        let second = export_rows(&rows, &home, &target).unwrap();
        assert_eq!(second.skipped, 1);
        assert!(sidecar.exists(), "skipped-identical 时应补写 sidecar");
    }
}
