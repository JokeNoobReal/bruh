#!/usr/bin/env python
"""
OCR worker thường trú.
Nạp EasyOCR đúng 1 lần rồi phục vụ nhiều job, thay vì spawn Python mỗi request.

Giao thức NDJSON (1 JSON / dòng):
  stdin  <- {"id":"...","type":"translate","images":[...],"lang":"en","instructions":""}
            {"type":"ping","id":"..."} | {"type":"shutdown"}
  stdout -> {"type":"ready"} | {"type":"pong"}
            {"id","type":"page",...} | {"id","type":"done","results":[...]} | {"id","type":"error"}
  stderr -> log thường + các dòng [STATUS]...[/STATUS] để Node đẩy sang SSE
"""
import os
import io
import sys
import json
import time
import threading
import traceback

# ── Tách kênh TRƯỚC khi import app: stdout = protocol, mọi print() -> stderr ──
try:
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

_proto = io.TextIOWrapper(
    os.fdopen(os.dup(1), "wb", 0), encoding="utf-8", errors="replace", line_buffering=True
)
os.dup2(2, 1)          # fd 1 trỏ vào stderr
sys.stdout = sys.stderr  # print() của comic_translator đi vào stderr

from comic_translator import process_single_image, build_clients  # noqa: E402
import easyocr  # noqa: E402

_emit_lock = threading.Lock()


def emit(obj):
    with _emit_lock:
        _proto.write(json.dumps(obj, ensure_ascii=False) + "\n")
        _proto.flush()


def log(msg):
    print(msg, file=sys.stderr, flush=True)


_readers = {}
_clients = None


def get_reader(lang):
    key = (lang or "en").strip() or "en"
    if key not in _readers:
        t0 = time.time()
        log(f"🚀 Nạp EasyOCR [{key}]...")
        import torch
        _readers[key] = easyocr.Reader(
            [l.strip() for l in key.split(",") if l.strip()],
            gpu=torch.cuda.is_available(),
        )
        log(f"✅ EasyOCR [{key}] sẵn sàng sau {time.time() - t0:.1f}s")
    return _readers[key]


def get_clients():
    global _clients
    if _clients is None:
        _clients = build_clients()
        if not _clients:
            raise RuntimeError("Không tìm thấy API Key nào trong .env")
    return _clients


def handle_translate(msg):
    rid = msg.get("id")
    images = [p for p in (msg.get("images") or []) if p]
    lang = msg.get("lang") or "en"
    instructions = msg.get("instructions") or ""

    if not images:
        emit({"id": rid, "type": "error", "message": "Không có ảnh nào để xử lý."})
        return

    reader = get_reader(lang)
    clients = get_clients()
    os.makedirs("public", exist_ok=True)

    results = []
    total = len(images)
    for i, img_path in enumerate(images):
        log(f"[STATUS]🔍 Đang quét OCR & Dịch trang {i + 1}/{total}...[/STATUS]")
        url = process_single_image(img_path, reader, clients, lang, instructions)
        if url:
            page = {"page": i + 1, "total": total, "url": url}
            results.append(page)
            emit({"id": rid, "type": "page", **page})

    emit({"id": rid, "type": "done", "results": results})


def main():
    # Làm nóng sẵn để request đầu tiên không phải chờ nạp model
    for lang in [l.strip() for l in os.getenv("OCR_PRELOAD_LANGS", "en").split(",") if l.strip()]:
        try:
            get_reader(lang)
        except Exception as e:
            log(f"⚠️ Không nạp trước được [{lang}]: {e}")

    emit({"type": "ready", "pid": os.getpid()})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            emit({"type": "error", "message": "JSON không hợp lệ"})
            continue

        mtype = msg.get("type")
        if mtype == "ping":
            emit({"id": msg.get("id"), "type": "pong"})
        elif mtype == "shutdown":
            log("👋 Nhận lệnh shutdown, thoát worker.")
            break
        elif mtype == "translate":
            try:
                handle_translate(msg)
            except Exception as e:
                traceback.print_exc(file=sys.stderr)
                emit({"id": rid if 'rid' in locals() else msg.get("id"), "type": "error", "message": str(e)})
        else:
            emit({"id": msg.get("id"), "type": "error", "message": f"Type lạ: {mtype}"})


if __name__ == "__main__":
    main()
