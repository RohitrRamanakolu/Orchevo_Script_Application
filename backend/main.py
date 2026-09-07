"""FastAPI backend that runs script.py as a subprocess for each chat message.

The script is executed verbatim — the only modification is replacing the
``"<value>"`` placeholder with the actual user query before each run.

Routes
------
POST /api/chat/stream       — run script.py with the query, stream stdout as SSE.
GET  /api/health-check      — health probe.
GET  /                      — serves the frontend static files.
"""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import tempfile
import traceback
import uuid
from typing import Any

import requests
import websockets

from fastapi import FastAPI, File, Form, UploadFile, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from script_transformer import rewrite_script

app = FastAPI(title="Chat Workflow Backend", version="1.0.0")

# ── CORS ──────────────────────────────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_SCRIPT_PATH: str = os.path.join(os.path.dirname(os.path.abspath(__file__)), "script.py")

# In-memory session store mapping frontend clients (IP or hardcoded) to platform session IDs
_SESSIONS: dict[str, str] = {}

# Workflow config pulled from script.py constants (kept in sync)
_WORKFLOW_KEY = "tq4iL76n_FafgnTW4eUCM4mrnfPYsmJSvmLrNY4EKRc"
_WORKFLOW_ID  = "21b69fd2-b0bf-4ac8-8ac6-be47c14af0b9"
_BASE_URL     = "https://map-qa.paradigmit.ai/api/v1/agent-workflows"


# ── Health ────────────────────────────────────────────────────────────────
@app.get("/api/health-check")
def health_check() -> dict[str, str]:
    """Return a simple health status.

    Returns
    -------
    dict[str, str]
        ``{"status": "ok"}``.
    """
    return {"status": "ok"}


# ── Helpers ───────────────────────────────────────────────────────────────
def _build_sse_line(data: dict[str, Any]) -> str:
    """Serialise a dict into an SSE ``data:`` line.

    Parameters
    ----------
    data : dict[str, Any]
        Payload to send to the client.

    Returns
    -------
    str
        Formatted SSE line with trailing double-newline.
    """
    assert isinstance(data, dict), "SSE data must be a dict"
    return f"data: {json.dumps(data)}\n\n"


def _run_script_and_stream(query: str, client_id: str, uploaded_file_path: str | None = None):
    """Read script.py, substitute the query, run it, and yield SSE events.

    The script's stdout (token prints) is streamed to the client in
    real time as ``token`` events. When the process finishes, a
    ``complete`` or ``error`` event is emitted.

    Parameters
    ----------
    query : str
        The user's chat message to inject into the script.
    client_id : str
        Identifier for the user to persist session across turns.
    uploaded_file_path: str | None
        Path to temporary uploaded file if any.

    Yields
    ------
    str
        SSE-formatted text lines.
    """
    assert isinstance(query, str) and len(query) > 0, "Query must be non-empty"
    assert os.path.isfile(_SCRIPT_PATH), f"script.py not found at {_SCRIPT_PATH}"

    tmp_path: str | None = None
    try:
        # ── Read and patch the script using AST ────────────────────────
        with open(_SCRIPT_PATH, encoding="utf-8") as fh:
            source = fh.read()

        active_session_id = _SESSIONS.get(client_id)
        files_map = {"file": uploaded_file_path} if uploaded_file_path else None

        # Rewrite the script with AST to inject inputs, files, and session
        modified_source = rewrite_script(
            script_source=source,
            query=query,
            session_id=active_session_id,
            files=files_map
        )

        # ── Write to a temp file next to script.py ────────────────────
        with tempfile.NamedTemporaryFile(
            mode="w",
            suffix=".py",
            delete=False,
            encoding="utf-8",
            dir=os.path.dirname(_SCRIPT_PATH),
        ) as tmp:
            tmp.write(modified_source)
            tmp_path = tmp.name

        # ── Run the script ────────────────────────────────────────────
        env = os.environ.copy()
        env["PYTHONUNBUFFERED"] = "1"

        process = subprocess.Popen(
            [sys.executable, tmp_path],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )

        full_output: list[str] = []
        stdout_fd = process.stdout.fileno()

        # Read stdout in real time — os.read returns whatever bytes are
        # available without waiting to fill the buffer.
        while True:
            data = os.read(stdout_fd, 4096)
            if not data:
                break
            text = data.decode("utf-8", errors="replace")
            full_output.append(text)
            
            # The script is printing raw tokens to stdout if it's streaming.
            yield _build_sse_line({"event": "token", "token": text})

        process.wait()

        output_text = "".join(full_output).strip()

        if process.returncode != 0:
            stderr_text = process.stderr.read().decode("utf-8", errors="replace")
            yield _build_sse_line({
                "event": "error",
                "detail": stderr_text or f"Script exited with code {process.returncode}",
            })
        else:
            # We attempt to extract the platform session ID if it was printed or if it was captured
            # In the AST rewritten script, we don't explicitly print the session_id unless we parse it.
            # But the script might print the final output. For simplicity, we just return what we captured.
            yield _build_sse_line({
                "event": "complete",
                "status": "success",
                "final_output": {"output": output_text},
            })

        yield "data: [DONE]\n\n"

    except Exception as exc:
        error_detail = f"{type(exc).__name__}: {exc}\n{traceback.format_exc()}"
        yield _build_sse_line({"event": "error", "detail": error_detail})
        yield "data: [DONE]\n\n"
    finally:
        if tmp_path is not None:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


# ── Audio WebSocket Proxy ────────────────────────────────────────────────
@app.websocket("/api/audio/stream/{stream_id}")
async def audio_stream_proxy(websocket: WebSocket, stream_id: str) -> None:
    """Accept browser binary audio frames and relay them to the upstream
    audio-streams WebSocket endpoint in real time.

    The browser:
      1. Opens this WS first (before calling /api/audio/execute).
      2. Sends binary audio frames (e.g. Opus/WebM chunks from MediaRecorder).
      3. Sends text frame ``"__end__"`` or closes the socket when done.

    Parameters
    ----------
    websocket : WebSocket
        Incoming client WebSocket connection.
    stream_id : str
        UUID generated by the browser; ties this audio queue to a workflow
        execution via stream_refs.
    """
    upstream_url = f"{_BASE_URL.replace('https://', 'wss://').replace('http://', 'ws://')}/audio-streams/{stream_id}"
    auth_headers = {"X-Workflow-Key": _WORKFLOW_KEY}

    await websocket.accept()
    try:
        async with websockets.connect(upstream_url, additional_headers=auth_headers) as upstream_ws:
            async def forward_browser_to_upstream() -> None:
                """Read from browser WebSocket, forward to upstream."""
                while True:
                    message = await websocket.receive()
                    if message["type"] == "websocket.disconnect":
                        break
                    raw = message.get("bytes") or message.get("text")
                    if raw is None:
                        break
                    if isinstance(raw, bytes):
                        await upstream_ws.send(raw)
                    else:
                        # Text frame — could be "__end__" sentinel or other control msg
                        await upstream_ws.send(raw)
                        if str(raw).strip() == "__end__":
                            break

            async def forward_upstream_to_browser() -> None:
                """Relay any upstream messages back to the browser."""
                async for msg in upstream_ws:
                    if isinstance(msg, bytes):
                        await websocket.send_bytes(msg)
                    else:
                        await websocket.send_text(msg)

            await asyncio.gather(
                forward_browser_to_upstream(),
                forward_upstream_to_browser(),
                return_exceptions=True,
            )
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        try:
            await websocket.send_text(json.dumps({"event": "error", "detail": str(exc)}))
        except Exception:
            pass
    finally:
        try:
            await websocket.close()
        except Exception:
            pass


@app.post("/api/audio/execute")
async def audio_execute(request: Request, stream_id: str = Form(...)) -> StreamingResponse:
    """Fire POST /execute/stream with stream_refs pointing at ``stream_id``.

    Call this *after* opening the ``/api/audio/stream/{stream_id}`` WebSocket
    so the upstream workflow engine can consume the live audio queue.

    Parameters
    ----------
    request : Request
        Incoming HTTP request (used to extract client IP for session tracking).
    stream_id : str
        UUID that was used to open the audio-streams WebSocket.

    Returns
    -------
    StreamingResponse
        SSE stream of workflow events (token, complete, error, [DONE]).
    """
    client_id = request.client.host if request.client else "default"

    return StreamingResponse(
        _run_audio_and_stream(stream_id, client_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


def _run_audio_and_stream(stream_id: str, client_id: str):
    """Create/reuse a platform session, fire execute/stream with stream_refs,
    and yield SSE events back to the browser.

    Parameters
    ----------
    stream_id : str
        Audio stream UUID tied to the open upstream WebSocket queue.
    client_id : str
        Identifies the user session across conversation turns.

    Yields
    ------
    str
        SSE-formatted event lines.
    """
    try:
        # Step 1: Obtain or reuse session
        session_id = _SESSIONS.get(client_id)
        if not session_id:
            sess_resp = requests.post(
                f"{_BASE_URL}/sessions",
                json={"workflow_id": _WORKFLOW_ID, "name": "Audio session"},
                headers={"X-Workflow-Key": _WORKFLOW_KEY},
                timeout=15,
            )
            sess_resp.raise_for_status()
            session_id = sess_resp.json()["session_id"]
            _SESSIONS[client_id] = session_id

        # Step 2: Fire execute/stream with stream_refs
        # stream_refs maps the workflow's audio_stream variable name to the live queue.
        # The variable name on the Start node must match — adjust if needed.
        resp = requests.post(
            f"{_BASE_URL}/execute/stream",
            data={
                "inputs": json.dumps({}),
                "stream_refs": json.dumps({"audio_input": stream_id}),
                "workflow_id": _WORKFLOW_ID,
                "session_id": session_id,
            },
            headers={"X-Workflow-Key": _WORKFLOW_KEY},
            stream=True,
            timeout=120,
        )
        resp.raise_for_status()

        # Step 3: Relay SSE events from upstream to browser
        token_buffer: list[str] = []
        for raw_line in resp.iter_lines():
            if not raw_line:
                continue
            line = raw_line.decode() if isinstance(raw_line, bytes) else raw_line
            if line == "data: [DONE]":
                break
            if not line.startswith("data:"):
                continue
            event = json.loads(line[5:].strip())
            ev = event.get("event")
            if ev == "session":
                new_sid = event.get("session_id")
                if new_sid:
                    _SESSIONS[client_id] = new_sid
            elif ev == "token":
                token_buffer.append(event.get("token", ""))
                yield _build_sse_line({"event": "token", "token": event.get("token", "")})
            elif ev == "complete":
                final = event.get("final_output", {}).get("output") or "".join(token_buffer)
                yield _build_sse_line({"event": "complete", "status": "success", "final_output": {"output": final}})
            elif ev == "error":
                yield _build_sse_line({"event": "error", "detail": event.get("detail", "Audio workflow error")})

        yield "data: [DONE]\n\n"

    except Exception as exc:
        yield _build_sse_line({"event": "error", "detail": f"{type(exc).__name__}: {exc}"})
        yield "data: [DONE]\n\n"


# ── Chat Streaming ────────────────────────────────────────────────────────
@app.post("/api/chat/stream")
async def chat_stream(
    request: Request,
    query: str = Form(...),
    file: UploadFile | None = File(default=None),
) -> StreamingResponse:
    """Run script.py with the given query and stream the result."""
    assert isinstance(query, str) and len(query) > 0, "Query must be non-empty"
    
    # Use client IP as a crude session identifier for single-user scenarios
    client_id = request.client.host if request.client else "default"
    
    uploaded_path = None
    if file and file.filename:
        # Save uploaded file to temp path
        with tempfile.NamedTemporaryFile(delete=False, suffix=os.path.splitext(file.filename)[1]) as f:
            f.write(await file.read())
            uploaded_path = f.name

    return StreamingResponse(
        _run_script_and_stream(query, client_id, uploaded_path),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ── Root → Odisha Govt Chatbot (new UI only) ────────────────────────────
_FRONTEND_DIR: str = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "frontend")
_CHATBOT_HTML: str = os.path.join(_FRONTEND_DIR, "chatbot.html")


@app.get("/", include_in_schema=False)
def serve_chatbot() -> FileResponse:
    """Serve the Odisha Govt Chatbot interface at the root URL.

    The classic UI files (index.html, etc.) remain on disk but are not
    wired to any backend route — they are simply not served.

    Returns
    -------
    FileResponse
        The chatbot.html file.
    """
    return FileResponse(_CHATBOT_HTML)


# ── Static assets (css / js / svg / etc.) ────────────────────────────────
# html=False ensures index.html is never auto-served for directory requests.
app.mount("/", StaticFiles(directory=_FRONTEND_DIR, html=False), name="frontend")
