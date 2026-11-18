"""P06 离线验证：5xx / 连接失败重试与 400 不重试，并确认请求数不再相乘。

只起一个 127.0.0.1 随机端口的假 OpenAI 兼容服务，另外用一个必定连不上的本地端口；
不连 8094，不碰 6299 进程与配置。

用法：venv\\Scripts\\python.exe patches\\test_p06.py
"""

from __future__ import annotations

import asyncio
import json
import logging
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from openai import APIConnectionError, AsyncOpenAI, BadRequestError, InternalServerError

from astrbot.core.provider.sources.openai_source import (
    ProviderOpenAIOfficial,
    _xzy_p06_create_with_retry,
)

OK_BODY = {
    "id": "chatcmpl-fake",
    "object": "chat.completion",
    "created": 0,
    "model": "fake-engine",
    "choices": [
        {
            "index": 0,
            "message": {"role": "assistant", "content": "OK"},
            "finish_reason": "stop",
        }
    ],
    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
}

ERR_500 = {
    "error": {
        "message": "prepared shared candidates exceeded the fixed subset bound",
        "type": "server_error",
        "code": 500,
    }
}

ERR_400 = {
    "error": {
        "message": "invalid request: unsupported parameter",
        "type": "invalid_request_error",
        "code": 400,
    }
}


class FakeEngine(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    plan: list = []
    hits: int = 0

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        self.rfile.read(length)
        type(self).hits += 1
        status, body = type(self).plan.pop(0) if type(self).plan else (200, OK_BODY)
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


class Capture(logging.Handler):
    def __init__(self):
        super().__init__()
        self.lines: list[str] = []

    def emit(self, record):
        self.lines.append(record.getMessage())


def dead_port() -> int:
    """占一个端口再释放，得到一个大概率直接拒绝连接的本地端口。"""
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


async def main() -> int:
    server = ThreadingHTTPServer(("127.0.0.1", 0), FakeEngine)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_address[1]

    # max_retries=0：关掉 SDK 自带重试，只观察 P06 这一层
    client = AsyncOpenAI(
        api_key="test-key",
        base_url=f"http://127.0.0.1:{port}/v1",
        max_retries=0,
        timeout=10,
    )

    cap = Capture()
    logging.getLogger("astrbot").addHandler(cap)

    async def call(create=None):
        return await _xzy_p06_create_with_retry(
            create or client.chat.completions.create,
            model="fake-engine",
            messages=[{"role": "user", "content": "hi"}],
            stream=False,
        )

    results = []

    # 场景 1：连接拒绝 —— 归 P06 重试，按策略耗尽后抛 APIConnectionError
    bad_client = AsyncOpenAI(
        api_key="test-key",
        base_url=f"http://127.0.0.1:{dead_port()}/v1",
        max_retries=0,
        timeout=5,
    )
    cap.lines.clear()
    t0 = time.monotonic()
    err = None
    try:
        await call(bad_client.chat.completions.create)
    except APIConnectionError as e:
        err = e
    elapsed = (time.monotonic() - t0) * 1000
    retry_lines = [line for line in cap.lines if "瞬时错误" in line]
    ok1 = (
        err is not None
        and len(retry_lines) == 2
        and any("重试耗尽（共 3 次尝试）" in line for line in cap.lines)
    )
    results.append(
        ("连接拒绝按策略重试并耗尽", ok1, "3 次尝试（日志计数）", elapsed, list(cap.lines))
    )
    await bad_client.close()

    # 场景 2：第 1 次 500，第 2 次 200 —— 重试后恢复
    FakeEngine.plan = [(500, ERR_500), (200, OK_BODY)]
    FakeEngine.hits = 0
    cap.lines.clear()
    t0 = time.monotonic()
    resp = await call()
    elapsed = (time.monotonic() - t0) * 1000
    ok2 = (
        resp.choices[0].message.content == "OK"
        and FakeEngine.hits == 2
        and any("重试后成功（第 2 次尝试）" in line for line in cap.lines)
    )
    results.append(("第 2 次成功即恢复", ok2, FakeEngine.hits, elapsed, list(cap.lines)))

    # 场景 3：连续 500 三次 —— 重试耗尽后抛错，日志可区分且保留上游原文
    FakeEngine.plan = [(500, ERR_500)] * 3
    FakeEngine.hits = 0
    cap.lines.clear()
    t0 = time.monotonic()
    err = None
    try:
        await call()
    except InternalServerError as e:
        err = e
    elapsed = (time.monotonic() - t0) * 1000
    ok3 = (
        err is not None
        and FakeEngine.hits == 3
        and any("重试耗尽（共 3 次尝试）" in line for line in cap.lines)
        and any("prepared shared candidates" in line for line in cap.lines)
    )
    results.append(("连续 500 三次后抛错", ok3, FakeEngine.hits, elapsed, list(cap.lines)))

    # 场景 4：400 参数错误 —— 不重试，只打一次
    FakeEngine.plan = [(400, ERR_400)]
    FakeEngine.hits = 0
    cap.lines.clear()
    t0 = time.monotonic()
    err = None
    try:
        await call()
    except BadRequestError as e:
        err = e
    elapsed = (time.monotonic() - t0) * 1000
    ok4 = (
        err is not None
        and FakeEngine.hits == 1
        and not any("[XZY-P06]" in line for line in cap.lines)
    )
    results.append(("400 不重试", ok4, FakeEngine.hits, elapsed, list(cap.lines)))

    # 场景 5：走真实 provider 构造 —— SDK max_retries 必须为 0；一次 _query 最多 3 个请求
    provider = ProviderOpenAIOfficial(
        {
            "key": ["test-key"],
            "model": "fake-engine",
            "api_base": f"http://127.0.0.1:{port}/v1",
            "timeout": 10,
        },
        {},
    )
    FakeEngine.plan = [(500, ERR_500)] * 3
    FakeEngine.hits = 0
    cap.lines.clear()
    err = None
    try:
        await provider._query(
            {"model": "fake-engine", "messages": [{"role": "user", "content": "hi"}]},
            None,
        )
    except InternalServerError as e:
        err = e
    ok5 = (
        err is not None
        and provider.client.max_retries == 0
        and FakeEngine.hits == 3
    )
    results.append(
        (
            "provider 实际请求数（SDK max_retries=0，不叠加）",
            ok5,
            FakeEngine.hits,
            None,
            [f"provider.client.max_retries = {provider.client.max_retries}"],
        )
    )
    await provider.client.close()

    print(f"假引擎: http://127.0.0.1:{port}/v1\n")
    for title, ok, hits, elapsed, lines in results:
        cost = f" | 耗时={elapsed:.0f}ms" if elapsed is not None else ""
        print(f"[{'PASS' if ok else 'FAIL'}] {title} | 实际请求数={hits}{cost}")
        for line in lines:
            print(f"        log> {line}")
        print()

    all_ok = all(ok for _, ok, _, _, _ in results)
    print("全部通过。" if all_ok else "存在失败项。")
    server.shutdown()
    await client.close()
    return 0 if all_ok else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
