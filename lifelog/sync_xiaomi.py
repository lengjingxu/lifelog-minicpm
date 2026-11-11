"""小米云盘相册同步：拉取云端相册条目并下载到本地目录（只读云端，不删本地文件）。

登录态复用本机的 token.mjs（小米云服务 App 的 CDP 取 token），
云端 API 与老项目的 sync.mjs 保持一致：/gallery/user/timeline、/gallery/user/galleries、
/gallery/{image,video}/storage，块数据用 RC4 + secure_key 解密。
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

HOST = "https://i.mi.com"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")
PAGE_SIZE = 100
MAX_PAGES = 200

TOKEN_HELPER = Path.home() / ".xiaomi-token" / "token.mjs"


class SyncError(RuntimeError):
    pass


class AuthExpired(SyncError):
    """登录态失效（401/403）：不重试，交给上层引导用户重新取 token。"""

    def __init__(self, message="小米云登录态已失效，请打开小米云服务 App 重新登录后重试"):
        super().__init__(message)


def get_credentials(force: bool = False) -> dict:
    """调用本机 token.mjs 取 serviceToken / userId。"""
    if not TOKEN_HELPER.exists():
        raise SyncError(f"缺少登录态助手 {TOKEN_HELPER}")
    script = (
        "import {getToken} from 'file://%s';"
        "const t = await getToken(%s);"
        "console.log(JSON.stringify(t));" % (TOKEN_HELPER, "{force:true}" if force else "")
    )
    result = subprocess.run(["node", "--input-type=module", "-e", script],
                            capture_output=True, text=True, timeout=180)
    if result.returncode != 0:
        raise SyncError("取登录态失败：" + result.stderr.strip()[:200])
    # 助手在被 import 时会自己打印一行结果，里面可能包含 token；
    # 取第一行含 serviceToken 的 JSON，并且不把它写进日志。
    data = None
    for line in result.stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            candidate = json.loads(line)
        except ValueError:
            continue
        if candidate.get("serviceToken"):
            data = candidate
            break
    if not data:
        raise SyncError("未取到 serviceToken")
    return {"token": data["serviceToken"], "userId": data["userId"]}


def _headers(cred: dict) -> dict:
    return {
        "Cookie": f"serviceToken={cred['token']}; userId={cred['userId']}",
        "Referer": "https://i.mi.com/",
        "User-Agent": UA,
        "Accept": "application/json, text/plain, */*",
    }


def http_json(path: str, query: dict, cred: dict, retries: int = 4, timeout: int = 30) -> dict:
    url = HOST + path + "?" + urllib.parse.urlencode({**query, "_dc": int(time.time() * 1000)})
    last = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers=_headers(cred))
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                body = resp.read().decode()
            return json.loads(body)
        except urllib.error.HTTPError as exc:
            if exc.code in (401, 403):
                # 登录态问题不重试：重试多少次都没用，直接引导重新取 token。
                raise AuthExpired(f"登录态失效（{exc.code}），请打开小米云服务 App 重新登录后重试")
            last = exc
        except Exception as exc:
            last = exc
        time.sleep(0.7 * (2 ** attempt))
    raise SyncError(f"请求 {path} 失败：{last}")


def list_range(cred: dict, start_date: str, end_date: str) -> list[dict]:
    """列出区间内的相册条目。start_date/end_date 形如 20240101。"""
    items: list[dict] = []
    seen: set[str] = set()
    for page in range(MAX_PAGES):
        data = http_json("/gallery/user/galleries",
                         {"startDate": start_date, "endDate": end_date,
                          "pageNum": page, "pageSize": PAGE_SIZE}, cred)
        if data.get("result") != "ok":
            raise SyncError("相册接口返回异常：" + str(data)[:160])
        block = data.get("data") or {}
        rows = block.get("galleries") or []
        added = 0
        for item in rows:
            key = str(item.get("id") or item.get("sha1") or "")
            if not key or key in seen:
                continue
            seen.add(key)
            items.append(item)
            added += 1
        if not rows or block.get("isLastPage") is True or (page > 0 and added == 0):
            break
        time.sleep(0.12)
    return items


def _rc4(key: bytes, data: bytes) -> bytes:
    s = list(range(256))
    j = 0
    for i in range(256):
        j = (j + s[i] + key[i % len(key)]) & 255
        s[i], s[j] = s[j], s[i]
    out = bytearray(len(data))
    i = j = 0
    for n, byte in enumerate(data):
        i = (i + 1) & 255
        j = (j + s[i]) & 255
        s[i], s[j] = s[j], s[i]
        out[n] = byte ^ s[(s[i] + s[j]) & 255]
    return bytes(out)


def _decode_key(value: str | None) -> bytes | None:
    if not value:
        return None
    text = value.strip()
    try:
        if all(ch in "0123456789abcdefABCDEF" for ch in text) and len(text) % 2 == 0:
            return bytes.fromhex(text)
        import base64
        return base64.b64decode(text)
    except Exception:
        return None


def download(cred: dict, item: dict, dest_dir: Path, date_hint: str | None = None) -> Path:
    """下载单个条目，返回本地路径。"""
    is_video = int(item.get("mediaType") or 0) == 1
    api = "/gallery/video/storage" if is_video else "/gallery/image/storage"
    storage = http_json(api, {"id": item["id"]}, cred)
    if storage.get("result") != "ok" or not (storage.get("data") or {}).get("kss"):
        raise SyncError(f"storage 返回异常：{item.get('fileName')}")
    kss = storage["data"]["kss"]
    key = _decode_key(kss.get("secure_key"))

    name = item.get("fileName") or f"{item.get('id')}.bin"
    stamp = date_hint or ""
    if not stamp:
        sort_time = int(item.get("sortTime") or 0)
        if sort_time:
            stamp = datetime.fromtimestamp(sort_time / 1000).strftime("%Y%m")
    if not stamp:
        digits = "".join(ch for ch in str(name) if ch.isdigit())
        if len(digits) >= 8:
            stamp = digits[:8]
    month = (stamp or datetime.now().strftime("%Y%m"))[:6]
    target_dir = dest_dir / month
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / name
    if target.exists() and target.stat().st_size == int(item.get("size") or -1):
        return target
    # 先写 .part，完整后再原子改名：中断留下的半截文件不会被 ingest 当成品。
    part = target.with_name(target.name + ".part")

    digest = hashlib.sha1()
    total = 0
    for block in kss.get("blocks") or []:
        size = int(block["size"])
        raw = None
        for url in block.get("urls") or []:
            try:
                req = urllib.request.Request(url, headers={
                    "Cookie": f"serviceToken={cred['token']}; userId={cred['userId']}",
                    "Referer": "https://i.mi.com/", "User-Agent": UA})
                with urllib.request.urlopen(req, timeout=180) as resp:
                    raw = resp.read()
                if len(raw) == size:
                    break
                raw = None
            except Exception:
                continue
        if raw is None:
            raise SyncError(f"块下载失败：{name}")
        data = _rc4(key, raw) if key else raw
        if block.get("sha1") and hashlib.sha1(data).hexdigest() != str(block["sha1"]).lower():
            raise SyncError(f"块校验失败：{name}")
        digest.update(data)
        total += len(data)
        with part.open("ab") as handle:
            handle.write(data)
    if item.get("size") and total != int(item["size"]):
        part.unlink(missing_ok=True)
        raise SyncError(f"大小不一致 {total}/{item['size']}：{name}")
    if item.get("sha1") and digest.hexdigest() != str(item["sha1"]).lower():
        part.unlink(missing_ok=True)
        raise SyncError(f"sha1 不一致：{name}")
    part.replace(target)
    return target


def sync(start_date: str, end_date: str, dest_dir: Path, limit: int | None = None,
         cred: dict | None = None) -> dict:
    cred = cred or get_credentials()
    items = list_range(cred, start_date, end_date)
    items.sort(key=lambda x: int(x.get("sortTime") or 0))
    if limit:
        items = items[-limit:]
    stats = {"listed": len(items), "ok": 0, "failed": 0}
    for index, item in enumerate(items, 1):
        try:
            download(cred, item, dest_dir, date_hint=item.get("date"))
            stats["ok"] += 1
        except Exception as exc:
            stats["failed"] += 1
            print(f"  失败 {item.get('fileName')}: {exc}")
        if index % 20 == 0:
            print(f"  已处理 {index}/{len(items)}")
    return stats


STATE_FILE = Path(os.environ.get("LIFELOG_SYNC_STATE",
                                Path(__file__).resolve().parent.parent / "data" / "sync_state.json"))


def load_state() -> dict:
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {"last_end": None, "index": {}}


def save_state(state: dict) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def incremental(start: str | None = None, end: str | None = None,
                dest_dir: Path | None = None, limit: int | None = None) -> dict:
    """增量同步：只拉上次之后新增的照片，已下载的按 sha1 跳过。"""
    state = load_state()
    index = state.get("index", {})
    if start:
        begin = start
    elif state.get("last_end"):
        begin = (datetime.strptime(state["last_end"], "%Y%m%d") + timedelta(days=1)).strftime("%Y%m%d")
    else:
        begin = (datetime.now() - timedelta(days=30)).strftime("%Y%m%d")
    finish = end or datetime.now().strftime("%Y%m%d")
    cred = get_credentials()
    items = list_range(cred, begin, finish)
    items.sort(key=lambda x: int(x.get("sortTime") or 0))
    stats = {"listed": len(items), "skipped": 0, "ok": 0, "failed": 0,
             "from": begin, "to": finish}
    dest = dest_dir or (Path(__file__).resolve().parent.parent / "data" / "photos")
    for item in items:
        sha1 = str(item.get("sha1") or "")
        if sha1 and sha1 in index:
            stats["skipped"] += 1
            continue
        try:
            path = download(cred, item, dest, date_hint=None)
            if sha1:
                index[sha1] = str(path)
            stats["ok"] += 1
        except Exception as exc:
            stats["failed"] += 1
            print(f"  失败 {item.get('fileName')}: {exc}")
    state["index"] = index
    state["last_end"] = finish
    save_state(state)
    return stats

# ---------------------------------------------------------------- 桌面端导入

def _target_path(item: dict, dest_dir: Path) -> Path:
    """条目的本地落盘路径（与 download 保持一致）。"""
    name = item.get("fileName") or f"{item.get('id')}.bin"
    stamp = item.get("date") or ""
    if not stamp:
        sort_time = int(item.get("sortTime") or 0)
        if sort_time:
            stamp = datetime.fromtimestamp(sort_time / 1000).strftime("%Y%m")
    if not stamp:
        digits = "".join(ch for ch in str(name) if ch.isdigit())
        if len(digits) >= 8:
            stamp = digits[:8]
    month = (stamp or datetime.now().strftime("%Y%m"))[:6]
    return dest_dir / month / name


def plan(cred: dict, start_date: str, end_date: str, dest_dir: Path,
         limit: int | None = None) -> dict:
    """只读计划：拉列表 + 与本地比对。

    严格只读：不建表、不写 state、不下载、不碰缩略图。
    """
    items = list_range(cred, start_date, end_date)
    items.sort(key=lambda x: int(x.get("sortTime") or 0))
    if limit:
        items = items[-limit:]

    new_items: list[dict] = []
    existing = 0
    total_bytes = 0
    for item in items:
        target = _target_path(item, dest_dir)
        size = int(item.get("size") or 0)
        if target.exists() and (not size or target.stat().st_size == size):
            existing += 1
            continue
        new_items.append({"id": item.get("id"), "name": target.name, "size": size,
                          "date": item.get("date")})
        total_bytes += size
    return {
        "listed": len(items),
        "new": len(new_items),
        "existing": existing,
        "bytes": total_bytes,
        "items": new_items[:500],
    }


def free_bytes(path: Path) -> int:
    """目标盘可用字节。读不到就返回 0（调用方按 fail-closed 处理）。"""
    try:
        out = subprocess.check_output(["df", "-Pk", str(path)], text=True)
        cols = out.splitlines()[1].split()
        return int(cols[3]) * 1024
    except Exception:
        return 0


def sync_import(cred: dict, start_date: str, end_date: str, dest_dir: Path,
                limit: int | None = None, jobs: int = 2,
                progress=None, should_cancel=None) -> dict:
    """下载并记账。可取消、可续传、并发不超过 2。

    progress: 可调用对象，收到 {"stage":..., "done":..., "total":..., "message":...}
    should_cancel: 返回 True 时停止（已下载的文件保留，重跑续传）。
    """
    from concurrent.futures import ThreadPoolExecutor

    items = list_range(cred, start_date, end_date)
    items.sort(key=lambda x: int(x.get("sortTime") or 0))
    if limit:
        items = items[-limit:]

    todo = []
    existing = 0
    total_bytes = 0
    for item in items:
        target = _target_path(item, dest_dir)
        size = int(item.get("size") or 0)
        if target.exists() and (not size or target.stat().st_size == size):
            existing += 1
            continue
        todo.append(item)
        total_bytes += size

    free = free_bytes(dest_dir)
    if free == 0:
        raise SyncError("无法读取目标盘可用空间，已拒绝下载")
    if total_bytes > free:
        raise SyncError(
            f"空间不足：需要 {total_bytes / 1e9:.1f} GB，可用 {free / 1e9:.1f} GB")

    state = load_state()
    index = state.get("index", {})
    # 已下载的按 sha1 记账，重跑直接跳过（续跑）。
    todo = [i for i in todo
            if not (str(i.get("sha1") or "") and str(i.get("sha1")) in index)]

    stats = {"listed": len(items), "existing": existing, "ok": 0, "failed": 0,
             "cancelled": False, "bytes": total_bytes}
    done = 0
    total = len(todo)
    lock = __import__("threading").Lock()

    def one(item: dict) -> tuple[bool, str]:
        try:
            download(cred, item, dest_dir, date_hint=item.get("date"))
            return True, ""
        except AuthExpired:
            raise
        except Exception as exc:
            return False, str(exc)

    with ThreadPoolExecutor(max_workers=max(1, min(jobs, 2))) as pool:
        futures = {pool.submit(one, item): item for item in todo}
        for future in futures:
            pass
        for future in list(futures):
            item = futures[future]
            if should_cancel and should_cancel():
                stats["cancelled"] = True
                for pending in futures:
                    pending.cancel()
                break
            try:
                ok, err = future.result()
            except AuthExpired:
                raise
            except Exception as exc:
                ok, err = False, str(exc)
            with lock:
                done += 1
                if ok:
                    stats["ok"] += 1
                    sha1 = str(item.get("sha1") or "")
                    if sha1:
                        index[sha1] = str(_target_path(item, dest_dir))
                    state["index"] = index
                else:
                    stats["failed"] += 1
                save_state(state)
                if progress:
                    progress({"stage": "xiaomi-download", "done": done, "total": total,
                              "message": f"已下载 {done}/{total}"})
    return stats
