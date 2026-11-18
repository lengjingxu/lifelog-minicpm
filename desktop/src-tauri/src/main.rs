// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // 诊断入口：只打印库里照片所在目录的授权检查结果，不开窗口。
    // 诊断：打印当前会使用的 Python 解释器（含 Pillow），不启动界面。
    if std::env::args().any(|arg| arg == "--python-report") {
        let home = std::env::var("LIFELOG_HOME").unwrap_or_else(|_| {
            format!(
                "{}/dev/lifelog-minicpm/data",
                std::env::var("HOME").unwrap_or_default()
            )
        });
        println!("{}", shiguang_mac_lib::python_report_for(&std::path::PathBuf::from(home)));
        return;
    }
    // 验收：跑真实 ingest，把桌面端会 emit 的进度事件逐行打出来。
    let args: Vec<String> = std::env::args().collect();
    if let Some(pos) = args.iter().position(|a| a == "--ingest-probe") {
        let folder = args.get(pos + 1).cloned().unwrap_or_default();
        match shiguang_mac_lib::ingest_probe(&folder) {
            Ok(events) => {
                for event in events { println!("{event}"); }
            }
            Err(err) => {
                eprintln!("{err}");
                std::process::exit(1);
            }
        }
        return;
    }
    if std::env::args().any(|arg| arg == "--access-report") {
        let home = std::env::var("LIFELOG_HOME").unwrap_or_else(|_| {
            format!(
                "{}/dev/lifelog-minicpm/data",
                std::env::var("HOME").unwrap_or_default()
            )
        });
        let report = shiguang_mac_lib::access_report_for(&std::path::PathBuf::from(home));
        println!("{}", serde_json::to_string(&report).unwrap_or_default());
        return;
    }
    shiguang_mac_lib::run()
}
