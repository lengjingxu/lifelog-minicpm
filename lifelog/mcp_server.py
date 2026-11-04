"""最小 MCP (stdio) 服务：把「这个人的生活」暴露给任意 AI 助手。"""
from __future__ import annotations

import json
import sys

from . import aggregate, profile as profile_mod, query

PROTOCOL_VERSION = "2024-11-05"

TOOLS = [
    {
        "name": "lifelog_ask",
        "description": "用自然语言询问这个人的相册生活记录（例如：我上个月常去哪？）。返回基于本地相册证据的回答。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "question": {"type": "string", "description": "要问的问题"},
                "top_k": {"type": "integer", "description": "检索条数，默认 12"},
            },
            "required": ["question"],
        },
    },
    {
        "name": "lifelog_search",
        "description": "按关键词检索相册记录，返回带日期的原始描述条目。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "since_day": {"type": "string", "description": "YYYY-MM-DD"},
                "until_day": {"type": "string", "description": "YYYY-MM-DD"},
                "limit": {"type": "integer"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "lifelog_day",
        "description": "返回某一天（或最近若干天）的照片量、标签与概括。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "day": {"type": "string", "description": "YYYY-MM-DD"},
                "span": {"type": "integer", "description": "从该天往后取几天，默认 1"},
            },
        },
    },
    {
        "name": "lifelog_profile",
        "description": "返回这个人的生活画像（节奏、场景、社交、兴趣）与统计底稿。",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "lifelog_journey",
        "description": "返回按时间排好的「人生经历」轨迹：每个年份下的生活片段、代表照片与描述。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "max_events": {"type": "integer", "description": "最多返回多少个片段，默认 40"}
            },
        },
    },
    {
        "name": "lifelog_events",
        "description": "返回按时间串起来的「生活片段」列表。",
        "inputSchema": {
            "type": "object",
            "properties": {"limit": {"type": "integer"}},
        },
    },
]


def _tool_result(payload) -> dict:
    text = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False, indent=2)
    return {"content": [{"type": "text", "text": text}]}


def call_tool(name: str, args: dict) -> dict:
    if name == "lifelog_ask":
        result = query.ask(args.get("question", ""), top_k=int(args.get("top_k", 12)))
        return _tool_result(result["answer"])
    if name == "lifelog_search":
        rows = query.search(args.get("query", ""), args.get("since_day"), args.get("until_day"),
                            int(args.get("limit", 12)))
        return _tool_result([{k: row.get(k) for k in ("day", "taken_at", "caption", "place",
                                                       "activity", "people", "tags")} for row in rows])
    if name == "lifelog_day":
        day = args.get("day")
        span = int(args.get("span", 1))
        with _db_session() as con:
            rows = con.execute(
                "SELECT day, photo_count, described, tags, summary FROM days "
                "WHERE day >= ? ORDER BY day LIMIT ?", (day or "0000-01-01", span)
            ).fetchall()
        return _tool_result([dict(row) for row in rows])
    if name == "lifelog_profile":
        stored = profile_mod.get_profile()
        stats = aggregate.compute_stats()
        return _tool_result({"画像": stored.get("summary", "尚未生成"),
                             "统计底稿": aggregate.stats_to_text(stats)})
    if name == "lifelog_journey":
        from . import journey
        payload = journey.build_journey(max_events=int(args.get("max_events", 40)))
        lines = []
        for section in payload["sections"]:
            lines.append(f"## {section['year']} 年")
            for event in section["events"]:
                photos = "；".join((p.get("caption") or "") for p in event["photos"][:3])
                lines.append(
                    f"- {event['start_day']}~{event['end_day']}｜{event['title']}"
                    f"（{event['photo_count']} 张）：{photos}"
                )
        return _tool_result(chr(10).join(lines))
    if name == "lifelog_events":
        with _db_session() as con:
            rows = con.execute(
                "SELECT start_day, end_day, title, summary, tags, photo_count FROM events "
                "ORDER BY start_day DESC LIMIT ?", (int(args.get("limit", 20)),)
            ).fetchall()
        return _tool_result([dict(row) for row in rows])
    raise KeyError(name)


def _db_session():
    from . import db
    return db.session()


def handle(message: dict) -> dict | None:
    method = message.get("method")
    mid = message.get("id")
    if method == "initialize":
        return {"jsonrpc": "2.0", "id": mid, "result": {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "lifelog-minicpm", "version": "0.1.0"},
        }}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": mid, "result": {"tools": TOOLS}}
    if method == "tools/call":
        params = message.get("params", {})
        try:
            result = call_tool(params.get("name", ""), params.get("arguments") or {})
        except Exception as exc:
            result = _tool_result(f"调用失败：{exc}")
        return {"jsonrpc": "2.0", "id": mid, "result": result}
    if method == "ping":
        return {"jsonrpc": "2.0", "id": mid, "result": {}}
    if mid is None:
        return None
    return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"未知方法 {method}"}}


def main() -> int:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except ValueError:
            continue
        response = handle(message)
        if response is not None:
            sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
            sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
