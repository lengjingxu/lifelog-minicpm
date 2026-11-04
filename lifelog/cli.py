"""lifelog 命令行入口。"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

from . import aggregate, caption, config, db, ingest, models, ocr, profile, query


def cmd_fetch_model(args) -> int:
    script = Path(__file__).resolve().parent.parent / "scripts" / "fetch_models.py"
    return subprocess.call([sys.executable, str(script), args.model])


def cmd_ingest(args) -> int:
    stats = ingest.ingest(args.roots, content_hash=args.hash, limit=args.limit)
    print(json.dumps(stats, ensure_ascii=False))
    return 0


def cmd_caption(args) -> int:
    stats = caption.run_caption(args.model, limit=args.limit, since_day=args.since,
                                until_day=args.until, sample=args.sample,
                                concurrency=args.concurrency)
    print(json.dumps(stats, ensure_ascii=False))
    return 0


def cmd_ocr(args) -> int:
    stats = ocr.run_ocr(args.model, limit=args.limit, since_day=args.since,
                        until_day=args.until, tag=args.tag)
    print(json.dumps(stats, ensure_ascii=False))
    return 0


def cmd_aggregate(args) -> int:
    days = aggregate.build_days(model=args.model)
    events = aggregate.build_events(model=args.model)
    print(json.dumps({"days": days, "events": events}, ensure_ascii=False))
    return 0


def cmd_profile(args) -> int:
    result = profile.build_profile(args.model, describe_model=args.describe_model)
    print(result["narrative"])
    print()
    print(aggregate.stats_to_text(result["stats"]))
    return 0


def cmd_ask(args) -> int:
    result = query.ask(args.question, model_key=args.model, top_k=args.top_k)
    print(result["answer"])
    return 0


def cmd_search(args) -> int:
    rows = query.search(args.query, args.since, args.until, args.limit)
    for row in rows:
        print(f"{row['day']} | {row.get('activity') or ''} | {row.get('place') or ''} | {row['caption']}")
    print(f"（{len(rows)} 条）")
    return 0


def cmd_stats(args) -> int:
    stats = aggregate.compute_stats()
    print(aggregate.stats_to_text(stats))
    return 0


def cmd_sync(args) -> int:
    from . import sync_xiaomi
    dest = Path(args.dest).expanduser() if args.dest else config.DATA_DIR / "photos"
    stats = sync_xiaomi.sync(args.start, args.end, dest, limit=args.limit)
    print(json.dumps(stats, ensure_ascii=False))
    return 0


def cmd_serve_mcp(args) -> int:
    from . import mcp_server
    return mcp_server.main()


def cmd_serve_web(args) -> int:
    from . import web
    web.serve(args.port)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="lifelog", description="本地相册 → MiniCPM → 生活档案")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("fetch-model", help="下载 MiniCPM 模型")
    p.add_argument("model", nargs="?", default="all")
    p.set_defaults(func=cmd_fetch_model)

    p = sub.add_parser("ingest", help="扫描相册目录登记资产")
    p.add_argument("roots", nargs="+")
    p.add_argument("--hash", action="store_true", help="按内容哈希去重（慢）")
    p.add_argument("--limit", type=int)
    p.set_defaults(func=cmd_ingest)

    p = sub.add_parser("caption", help="用 MiniCPM 逐张识别")
    p.add_argument("--model", default="minicpm-v-4.7-1b")
    p.add_argument("--limit", type=int)
    p.add_argument("--sample", type=int, help="跨全时间轴等距抽样 N 张")
    p.add_argument("--concurrency", type=int, default=1, help="并发请求数（llama.cpp 多 slot）")
    p.add_argument("--since")
    p.add_argument("--until")
    p.set_defaults(func=cmd_caption)

    p = sub.add_parser("ocr", help="用 MiniCPM-OCR 抽图内文字")
    p.add_argument("--model", default="minicpm-ocr-1.0")
    p.add_argument("--limit", type=int)
    p.add_argument("--tag", help="只对带该标签的图抽字，如 屏幕截图")
    p.add_argument("--since")
    p.add_argument("--until")
    p.set_defaults(func=cmd_ocr)

    p = sub.add_parser("aggregate", help="聚合成天与生活片段")
    p.add_argument("--model")
    p.set_defaults(func=cmd_aggregate)

    p = sub.add_parser("profile", help="生成生活画像")
    p.add_argument("--model", default="minicpm-v-4.7-1b")
    p.add_argument("--describe-model", default=None)
    p.set_defaults(func=cmd_profile)

    p = sub.add_parser("ask", help="用自然语言问这个人最近的生活")
    p.add_argument("question")
    p.add_argument("--model", default="minicpm-v-4.7-1b")
    p.add_argument("--top-k", type=int, default=12)
    p.set_defaults(func=cmd_ask)

    p = sub.add_parser("search", help="检索相册记录")
    p.add_argument("query")
    p.add_argument("--since")
    p.add_argument("--until")
    p.add_argument("--limit", type=int, default=12)
    p.set_defaults(func=cmd_search)

    p = sub.add_parser("stats", help="查看统计底稿")
    p.set_defaults(func=cmd_stats)

    p = sub.add_parser("sync", help="从小米云盘同步相册到本地")
    p.add_argument("--start", required=True, help="起始日期 YYYYMMDD")
    p.add_argument("--end", required=True, help="结束日期 YYYYMMDD")
    p.add_argument("--dest", help="下载目录，默认 data/photos")
    p.add_argument("--limit", type=int)
    p.set_defaults(func=cmd_sync)

    p = sub.add_parser("serve-mcp", help="以 MCP stdio 服务运行")
    p.set_defaults(func=cmd_serve_mcp)

    p = sub.add_parser("serve-web", help="启动本地网页查看")
    p.add_argument("--port", type=int, default=8766)
    p.set_defaults(func=cmd_serve_web)

    return parser


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    db.init_db()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
