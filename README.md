# 拾光 LifeLog · MiniCPM 本地生活记忆引擎

把私人相册变成一份 AI 能随时读懂的「生活档案」。

全流程跑在本地：**小米云盘同步 → 本地入库 → MiniCPM 逐张理解 → 生活画像与生活片段 → 通过 MCP / CLI 让任意 AI 提问**。
照片和描述一次都不出本机，模型用 MiniCPM 系列的官方 GGUF（llama.cpp / Metal）。

> 这是从零复刻的独立项目，与已有的 `photo-memory` / `photo-sync` 完全解耦：
> 独立代码库、独立数据库、独立模型选型（Qwen3-VL → MiniCPM）。

## 它解决什么

相册里的信息是「散点」：一张图一句话。要让 AI 真的了解一个人，需要把照片变成
**可检索、可聚合、可叙事**的数据。拾光做四件事：

1. **收得进来** — 小米云盘相册增量同步到本地（只读云端，不删本地文件），或直接扫描本地相册目录。
2. **看得懂** — 每张照片交给 MiniCPM 产出结构化描述：场景、人物、地点线索、正在做的事、氛围、标签。
3. **串得起来** — 按天聚合成「一天的样子」，按连续拍摄串成「生活片段」，再统计出生活节奏、场景分布、社交构成。
4. **问得到** — 生成一份「生活画像」，并通过 MCP 工具暴露给 AI：问「我上个月常去哪」「我一个人待着的时候都在干什么」都能答。

## 模型矩阵（全部本地）

| key | 模型 | 体量 | 在项目里的角色 |
| --- | --- | --- | --- |
| `minicpm-v-4.7-1b` | MiniCPM-V-4.7-1B | 1.1 GB | 全库逐张识别，端侧速度（Apple Silicon 实测 ~1.5 s/张） |
| `minicpm-v-4.5-8b` | MiniCPM-V-4.5-8B | 5.0 GB | 深度理解：对重点照片、成组照片做细粒度解读与画像生成 |
| `minicpm-ocr-1.0` | MiniCPM-OCR-1.0 | 0.8 GB | 图内文字抽取：截屏、订单、票据、路牌、招牌 |
| `minicpm-ocr-jev` | MiniCPM-OCR-Jev | 2.0 GB | OCR 备选/互校 |

模型权重来自 openbmb 官方 GGUF 仓库，下载走 hf-mirror 镜像，可断点续传。

## 一键演示（100 张试跑）

```bash
bash scripts/demo.sh /Volumes/Leng/照片 4
```

依次完成：登记资产 → MiniCPM-V-4.7-1B 逐张理解（全时间轴等距抽 100 张）→
聚合成天/生活片段 → MiniCPM-V-4.5-8B 写生活画像 → 自然语言提问。

## 快速开始

```bash
cd ~/lifelog-minicpm
python3 -m venv .venv && .venv/bin/pip install pillow pillow-heif

# 1) 拉模型（1B 必需，其余按需）
.venv/bin/python scripts/fetch_models.py minicpm-v-4.7-1b
.venv/bin/python scripts/fetch_models.py minicpm-v-4.5-8b
.venv/bin/python scripts/fetch_models.py minicpm-ocr-1.0

# 2) 登记资产（本地相册目录）
.venv/bin/python -m lifelog.cli ingest /Volumes/Leng/照片

# 3) MiniCPM 逐张理解（可随时中断，重复执行自动续跑）
.venv/bin/python -m lifelog.cli caption --model minicpm-v-4.7-1b
.venv/bin/python -m lifelog.cli caption --model minicpm-v-4.7-1b --sample 200   # 全时间轴等距抽样试跑

# 4) 图内文字
.venv/bin/python -m lifelog.cli ocr --model minicpm-ocr-1.0

# 5) 聚合成天 / 生活片段 / 生活画像
.venv/bin/python -m lifelog.cli aggregate
.venv/bin/python -m lifelog.cli profile --model minicpm-v-4.5-8b

# 6) 提问
.venv/bin/python -m lifelog.cli ask "我上个月常去哪里？"

# 7) 本地网页
.venv/bin/python -m lifelog.cli serve-web --port 8766

# 8) 小米云盘相册同步（只读云端）
.venv/bin/python -m lifelog.cli sync --start 20240101 --end 20241231
```

## 接入 AI（MCP）

项目自带最小 MCP stdio 服务，暴露 5 个工具：
`lifelog_ask`、`lifelog_search`、`lifelog_day`、`lifelog_profile`、`lifelog_events`。

```json
{
  "mcpServers": {
    "lifelog": {
      "command": "/Users/leng/lifelog-minicpm/.venv/bin/python",
      "args": ["-m", "lifelog.mcp_server"],
      "cwd": "/Users/leng/lifelog-minicpm"
    }
  }
}
```

## 目录结构

```
lifelog-minicpm/
├── lifelog/
│   ├── config.py        # 路径与模型注册表
│   ├── db.py            # SQLite：assets / captions / days / events / profile
│   ├── ingest.py        # 相册目录扫描、EXIF 时间与 GPS
│   ├── sync_xiaomi.py   # 小米云盘相册同步（timeline/galleries/storage + RC4 解密）
│   ├── models.py        # llama.cpp 服务进程管理 + OpenAI 兼容多模态请求
│   ├── caption.py       # MiniCPM 逐张结构化描述（断点续跑、prompt 版本化）
│   ├── ocr.py           # MiniCPM-OCR 图内文字抽取
│   ├── aggregate.py     # 按天 / 生活片段 / 统计底稿
│   ├── profile.py       # 生活画像（MiniCPM 写作）
│   ├── query.py         # 检索与问答
│   ├── mcp_server.py    # MCP stdio 服务
│   ├── web.py           # 本地网页
│   └── cli.py           # 命令行
├── scripts/fetch_models.py
└── docs/报名材料.md
```

## 数据与隐私

- 照片、描述、画像、索引全部落在本地 `data/lifelog.sqlite`，默认不发出任何网络请求。
- 已实测：Apple M6 / 16 GB 上，1B 模型识别约 1.2 张/秒（4 并发）；8B 模型写画像单次约 40 秒。

## 踩坑备忘

- **16 GB 机器上 8B 模型要用 `-c 4096`**：config.py 里 MiniCPM-V-4.5-8B 的 ctx 已设为 4096，
  8192 会触发 Metal Insufficient Memory。
- **MiniCPM-OCR 需要 llama.cpp ≥ 0.8**：0.7.0 不认识 minicpm_ocr_1_0 投影器；
  OCR 服务还必须带 --jinja --reasoning off，否则只会回一句「无可读文字」。
- **4.5-8B 是思考型模型**：不关 reasoning 时答案落在 reasoning_content 里，content 为空；
  配置里已加 --reasoning off，画像生成失败还会自动降级到 1B 模型。

- 只用本地 GGUF 权重做推理，不调用任何云端视觉 API。
- 小米云盘同步只读云端、只写本地目录，不删除任何云端或本地文件。
