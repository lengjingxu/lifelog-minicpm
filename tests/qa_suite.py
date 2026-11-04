#!/usr/bin/env python3
"""问答测试套件：对同一份生活档案问一组问题，检查答案是否有记录支撑。

用法:
    .venv/bin/python tests/qa_suite.py --model minicpm-v-4.5-8b
"""
from __future__ import annotations

import argparse
import json
import time
from datetime import datetime
from pathlib import Path

import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lifelog import models, profile as profile_mod, query  # noqa: E402

QUESTIONS = [
    ("作息", "我一天里通常什么时段在外面活动？拍照集中在什么时候？"),
    ("独处", "我一个人待着的时候一般在做什么？"),
    ("家人", "我拍到和家人在一起的时刻多吗？一般是什么场景？"),
    ("地点", "我记录里出现最多的地方是哪些类型的地方？"),
    ("旅行", "2023年12月那趟旅行主要在哪里？"),
    ("情绪", "这些照片整体是什么氛围？"),
    ("变化", "记录里能看出我的生活有什么变化吗？"),
    ("工作", "我的照片里有工作、办公相关的内容吗？"),
    ("居住", "从记录里能判断我住在哪里、住在什么样的地方吗？"),
    ("饮食", "我常在外面吃饭还是在家？"),
    ("爱好", "除了拍照和看风景，我的记录里还看得出什么爱好？"),
    ("规模", "我的相册一共被识别了多少张照片，覆盖了多少天？"),
]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="minicpm-v-4.5-8b")
    parser.add_argument("--top-k", type=int, default=10)
    parser.add_argument("--out", default="reports/qa-report.json")
    args = parser.parse_args()

    results = []
    started = time.time()
    for label, question in QUESTIONS:
        t0 = time.time()
        outcome = query.ask(question, model_key=args.model, top_k=args.top_k)
        rows = outcome["evidence"]
        results.append({
            "label": label,
            "question": question,
            "answer": outcome["answer"],
            "evidence": len(rows),
            "days": sorted({r["day"] for r in rows if r.get("day")}),
            "stats_used": outcome.get("stats_used", False),
            "seconds": round(time.time() - t0, 1),
        })
        print(f"[{label}] 证据{len(rows)}条 "
              f"{'(统计模式)' if outcome.get('stats_used') else ''} "
              f"{outcome['answer'][:90]}")

    payload = {
        "model": args.model,
        "note": "答案与证据条数由 lifelog.query.ask 产出",
        "at": datetime.now().isoformat(timespec="seconds"),
        "total_seconds": round(time.time() - started, 1),
        "results": results,
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n报告已写入 {out}（总耗时 {payload['total_seconds']}s）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
