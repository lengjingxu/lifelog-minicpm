# 示例数据（24 张）

用来在没有真实相册、也不想跑模型的机器上开发 UI。

- `lifelog.sqlite`：24 条 assets + 对应 captions（真实 AI 输出），结构与生产库一致
- `photos/`：原图（`path` 字段是相对路径，客户端按 `data_dir` 解析）
- `thumbs/`：360px 缩略图（客户端直接读，不会再生成）

启动时指向这里：

```bash
LIFELOG_HOME="$PWD/sample-data" npm run tauri dev
```

要换成真实库：把 `LIFELOG_HOME` 指到 `lifelog-minicpm/data` 即可（那里有 `lifelog.sqlite` 与 `thumbs/`）。
