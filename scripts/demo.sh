#!/bin/bash
# 一键演示：100 张试跑，完整跑通「相册 → MiniCPM → 生活档案 → 提问」
# 用法: bash scripts/demo.sh [相册目录] [并发数]
set -e
cd "$(dirname "$0")/.."
PY=".venv/bin/python"
ROOT="${1:-/Volumes/Leng/照片}"
CONC="${2:-4}"

echo "== 0. 环境自检"
$PY -m lifelog.cli doctor

echo "== 1. 登记资产"
$PY -m lifelog.cli ingest "$ROOT"

echo "== 2. MiniCPM-V-4.7-1B 逐张理解（全时间轴等距抽样 100 张）"
$PY -m lifelog.cli caption --model minicpm-v-4.7-1b --sample 100 --concurrency "$CONC"

echo "== 3. 聚合成天与生活片段"
$PY -m lifelog.cli aggregate

echo "== 4. MiniCPM-V-4.5-8B 写生活画像"
$PY -m lifelog.cli profile --model minicpm-v-4.5-8b

echo "== 5. 提问"
$PY -m lifelog.cli ask "我平时都在哪里活动？"

echo "== 6. 本地网页: http://127.0.0.1:8766"
echo "   人生经历页: http://127.0.0.1:8766/journey"
