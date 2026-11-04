"""MiniCPM 本地推理：llama.cpp 服务进程管理 + OpenAI 兼容对话接口。"""
from __future__ import annotations

import base64
import json
import mimetypes
import socket
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

from . import config

DEFAULT_PORT = 8077


class ModelError(RuntimeError):
    pass


def model_paths(key: str) -> tuple[Path, Path | None]:
    spec = config.MODELS[key]
    root = config.MODELS_DIR / spec["dir"]
    gguf = root / spec["gguf"]
    mmproj = root / spec["mmproj"]
    return gguf, (mmproj if mmproj.exists() else None)


def model_ready(key: str) -> bool:
    gguf, mmproj = model_paths(key)
    if not gguf.exists():
        return False
    if mmproj is None:
        return False
    return gguf.stat().st_size > 1024 * 1024


def require_model(key: str) -> tuple[Path, Path]:
    if key not in config.MODELS:
        raise ModelError(f"未注册的模型: {key}")
    gguf, mmproj = model_paths(key)
    if not gguf.exists():
        raise ModelError(f"缺少模型文件 {gguf}，先运行: lifelog fetch-model {key}")
    if mmproj is None:
        raise ModelError(f"缺少 mmproj 视觉投影文件: {gguf.parent}/{config.MODELS[key]['mmproj']}")
    return gguf, mmproj


def free_port(preferred: int = DEFAULT_PORT) -> int:
    for port in range(preferred, preferred + 40):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            if sock.connect_ex(("127.0.0.1", port)) != 0:
                return port
    raise ModelError("没有可用端口")


class Server:
    """按需拉起 llama-server，用完即停。"""

    def __init__(self, key: str, port: int | None = None, ctx: int | None = None,
                 parallel: int = 1, verbose: bool = False):
        self.key = key
        self.spec = config.MODELS[key]
        self.port = port or free_port()
        self.parallel = max(1, int(parallel))
        self.ctx = ctx or self.spec.get("ctx", 8192)
        if self.parallel > 1:
            self.ctx = self.ctx * self.parallel
        self.verbose = verbose
        self.proc: subprocess.Popen | None = None

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def start(self, timeout: float = 180) -> "Server":
        gguf, mmproj = require_model(self.key)
        cmd = [
            config.LLAMA_SERVER_BIN,
            "-m", str(gguf),
            "--mmproj", str(mmproj),
            "--host", "127.0.0.1",
            "--port", str(self.port),
            "-c", str(self.ctx),
            "-ngl", "99",
            "--no-warmup",
        ]
        if self.parallel > 1:
            cmd += ["-np", str(self.parallel)]
        cmd += list(self.spec.get("extra_args", []))
        log_path = config.LOG_DIR / f"llama-server-{self.key}-{self.port}.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        self.log_path = log_path
        self.proc = subprocess.Popen(
            cmd, stdout=subprocess.DEVNULL, stderr=open(log_path, "w")
        )
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise ModelError(f"llama-server 启动失败（退出码 {self.proc.returncode}）")
            try:
                with urllib.request.urlopen(self.base_url + "/health", timeout=2) as resp:
                    if resp.status == 200:
                        return self
            except Exception:
                time.sleep(1.0)
        self.stop()
        raise ModelError("llama-server 启动超时")

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=20)
            except subprocess.TimeoutExpired:
                self.proc.kill()

    def __enter__(self) -> "Server":
        return self.start()

    def __exit__(self, *exc) -> None:
        self.stop()

    # --- 请求 ---

    def chat(self, prompt: str, images: list[Path] | None = None, max_tokens: int = 320,
             temperature: float = 0.0, timeout: float = 300) -> str:
        content: list[dict] = [{"type": "text", "text": prompt}]
        for path in images or []:
            content.append({
                "type": "image_url",
                "image_url": {"url": image_data_url(path)},
            })
        payload = {
            "model": self.key,
            "messages": [{"role": "user", "content": content}],
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": False,
        }
        req = urllib.request.Request(
            self.base_url + "/v1/chat/completions",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = json.loads(resp.read().decode())
        except urllib.error.HTTPError as exc:
            tail = ""
            try:
                tail = self.log_path.read_text(errors="ignore")[-400:]
            except Exception:
                pass
            raise ModelError(
                f"llama-server 返回 HTTP {exc.code}（模型 {self.key}）。"
                f"常见原因是 16 GB 机器上上下文过大导致 Metal 显存不足，可把 config.py 里的 "
                f"ctx 调小或换更小的模型。服务日志尾部：{tail[-300:]}"
            ) from exc
        message = data["choices"][0]["message"]
        content = (message.get("content") or "").strip()
        if not content:
            content = (message.get("reasoning_content") or "").strip()
        return content


def image_data_url(path: Path, max_side: int = 1024, quality: int = 88) -> str:
    """把本地图片转成 data URL，控制长边以省内存和带宽。"""
    mime = mimetypes.guess_type(str(path))[0] or "image/jpeg"
    raw = Path(path).read_bytes()
    if path.suffix.lower() in {".heic", ".heif"}:
        raw = heic_to_jpeg(raw, max_side)
        mime = "image/jpeg"
    else:
        try:
            from PIL import Image
            from io import BytesIO

            with Image.open(BytesIO(raw)) as image:
                image = image.convert("RGB")
                if max(image.size) > max_side:
                    scale = max_side / max(image.size)
                    image = image.resize((int(image.width * scale), int(image.height * scale)))
                buf = BytesIO()
                image.save(buf, format="JPEG", quality=quality)
                raw = buf.getvalue()
                mime = "image/jpeg"
        except Exception:
            pass
    return f"data:{mime};base64," + base64.b64encode(raw).decode()


def heic_to_jpeg(raw: bytes, max_side: int) -> bytes:
    from io import BytesIO

    import pillow_heif
    from PIL import Image

    pillow_heif.register_heif_opener()
    with Image.open(BytesIO(raw)) as image:
        image = image.convert("RGB")
        if max(image.size) > max_side:
            scale = max_side / max(image.size)
            image = image.resize((int(image.width * scale), int(image.height * scale)))
        buf = BytesIO()
        image.save(buf, format="JPEG", quality=88)
        return buf.getvalue()
