"""FastAPI backend that executes Paradigm Platform workflow scripts as subprocesses.

Credentials (WORKFLOW_KEY, WORKFLOW_ID, BASE_URL) and input/output metadata are
introspected dynamically from ``script.py`` on every request via
``script_transformer.inspect_script`` — dropping a new ``script.py`` automatically
reconfigures the backend without a restart.

Routes
------
POST /odisha/api/chat/stream           — rewrite script.py, run as subprocess, stream SSE.
POST /odisha/api/audio/execute         — fire execute/stream with stream_refs, relay SSE.
WS   /odisha/api/audio/stream/{id}     — proxy mic audio to upstream audio-streams WS.
GET  /odisha/api/health-check          — health probe.
GET  /                                 — serves chatbot.html.
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

from script_transformer import (
    inspect_script,
    resolve_audio_stream_var_name,
    rewrite_script,
    ScriptMetadata,
)

app = FastAPI(title="Chat Workflow Backend", version="1.0.0")

# Public path prefix for all HTTP/WS APIs (shared with the frontend ENDPOINTS).
_API_PREFIX: str = "/odisha"

# ── CORS ──────────────────────────────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_SCRIPT_PATH: str = os.path.join(os.path.dirname(os.path.abspath(__file__)), "script.py")

# In-memory session store mapping frontend client IPs to platform session IDs
_SESSIONS: dict[str, str] = {}

# Stdout marker emitted by script.py to carry the full final_output JSON payload
# (including base64 audio data) back to the subprocess runner.
_FINAL_OUTPUT_MARKER: str = "__FINAL_OUTPUT__:"

# Byte size for each non-blocking stdout read. Large __FINAL_OUTPUT__ lines
# (base64 audio) routinely exceed this, so the reader must reassemble across reads.
_STDOUT_READ_SIZE: int = 4096

# Max characters of an upstream error body to include in raised exceptions.
_UPSTREAM_ERROR_BODY_LIMIT: int = 500


def _parse_final_output_marker_line(stripped_line: str) -> dict[str, Any] | None:
    """Parse a complete ``__FINAL_OUTPUT__:<json>`` line into a dict.

    Parameters
    ----------
    stripped_line:
        One stdout line with leading/trailing whitespace already removed.
        Must start with ``_FINAL_OUTPUT_MARKER``.

    Returns
    -------
    dict[str, Any] | None
        Parsed JSON object, or ``None`` when the JSON is not yet valid.

    Raises
    ------
    AssertionError
        If ``stripped_line`` does not start with the marker.
    """
    assert isinstance(stripped_line, str), "stripped_line must be a string"
    assert stripped_line.startswith(_FINAL_OUTPUT_MARKER), (
        f"Expected marker prefix {_FINAL_OUTPUT_MARKER!r}, got {stripped_line[:40]!r}"
    )
    json_part = stripped_line[len(_FINAL_OUTPUT_MARKER) :]
    try:
        payload = json.loads(json_part)
    except json.JSONDecodeError:
        return None
    assert isinstance(payload, dict), (
        f"__FINAL_OUTPUT__ payload must be a JSON object, got {type(payload).__name__}"
    )
    return payload


def _is_final_output_line_prefix(text: str) -> bool:
    """Return True if ``text`` is a full or incomplete ``__FINAL_OUTPUT__`` line.

    Used to hold partial stdout across ``os.read`` boundaries so base64 audio
    is never forwarded as SSE token events.
    """
    assert isinstance(text, str), "text must be a string"
    stripped = text.lstrip()
    if not stripped:
        return False
    if stripped.startswith(_FINAL_OUTPUT_MARKER):
        return True
    return _FINAL_OUTPUT_MARKER.startswith(stripped)


def _get_script_metadata() -> ScriptMetadata:
    """Read and introspect script.py, returning its embedded metadata.

    Called on every audio request so credentials always reflect the current
    script.py on disk without needing a server restart.

    Returns
    -------
    ScriptMetadata
        Parsed credentials, variable names, and streaming flags.

    Raises
    ------
    FileNotFoundError
        If script.py does not exist at the expected path.
    ValueError
        If the script is missing WORKFLOW_KEY or WORKFLOW_ID.
    """
    assert os.path.isfile(_SCRIPT_PATH), f"script.py not found at {_SCRIPT_PATH}"
    with open(_SCRIPT_PATH, encoding="utf-8") as fh:
        source = fh.read()
    return inspect_script(source)


# ── Health ────────────────────────────────────────────────────────────────
@app.get(f"{_API_PREFIX}/api/health-check")
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


def _raise_for_upstream_status(resp: requests.Response, context: str) -> None:
    """Raise with status and response body when an upstream call fails.

    Parameters
    ----------
    resp : requests.Response
        Response from Paradigm ``/execute/stream`` (or similar).
    context : str
        Short label included in the error message (e.g. ``audio execute``).

    Raises
    ------
    RuntimeError
        When ``resp`` is not a successful HTTP response.
    """
    assert resp is not None, "upstream response must not be None"
    assert isinstance(context, str) and context, "context must be a non-empty string"
    if resp.ok:
        return
    body = (resp.text or "").strip()[:_UPSTREAM_ERROR_BODY_LIMIT]
    detail = f" — {body}" if body else ""
    raise RuntimeError(
        f"Upstream {context} failed with HTTP {resp.status_code}{detail}"
    )


def _files_map_for_upload(meta: ScriptMetadata, uploaded_file_path: str) -> dict[str, str]:
    """Build the ``files`` map for ``rewrite_script`` from script metadata.

    Parameters
    ----------
    meta : ScriptMetadata
        Introspected script metadata (must declare at least one file var).
    uploaded_file_path : str
        Absolute path to the temporary uploaded file on disk.

    Returns
    -------
    dict[str, str]
        Mapping ``{start_var_name: local_path}`` for AST rewriting.

    Raises
    ------
    ValueError
        If ``script.py`` declares no multipart file variables.
    """
    assert isinstance(meta, ScriptMetadata), "meta must be ScriptMetadata"
    assert isinstance(uploaded_file_path, str) and uploaded_file_path, \
        "uploaded_file_path must be a non-empty string"
    assert os.path.isfile(uploaded_file_path), \
        f"uploaded file does not exist: {uploaded_file_path}"

    if not meta.file_var_names:
        raise ValueError(
            "An uploaded file was provided, but script.py declares no "
            "files={...} multipart variables to bind it to."
        )
    # Prefer stream/input Start vars over TTS output names (same ranking as live mic).
    bind_name = resolve_audio_stream_var_name(meta)
    assert isinstance(bind_name, str) and bind_name, "bind_name must be non-empty"
    return {bind_name: uploaded_file_path}


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
    assert isinstance(query, str), "Query must be a string"
    assert os.path.isfile(_SCRIPT_PATH), f"script.py not found at {_SCRIPT_PATH}"
    has_upload = isinstance(uploaded_file_path, str) and bool(uploaded_file_path)
    if not query.strip() and not has_upload:
        raise ValueError("Provide a text query and/or an uploaded audio/file")

    tmp_path: str | None = None
    try:
        # ── Read and patch the script using AST ────────────────────────
        with open(_SCRIPT_PATH, encoding="utf-8") as fh:
            source = fh.read()

        meta = inspect_script(source)
        # Dual-input: text query (omit files=) OR mic WAV upload bound to the
        # multipart Start var discovered from script.py (empty query → STT).

        active_session_id = _SESSIONS.get(client_id)
        files_map: dict[str, str] | None = None
        if has_upload:
            assert uploaded_file_path is not None
            files_map = _files_map_for_upload(meta, uploaded_file_path)

        # Rewrite the script with AST to inject inputs, files, and session
        modified_source = rewrite_script(
            script_source=source,
            query=query.strip(),
            session_id=active_session_id,
            files=files_map,
        )

        # Write outside the backend package dir. With ``uvicorn --reload``,
        # a temp ``.py`` next to ``main.py`` triggers WatchFiles, which
        # restarts the server and raises KeyboardInterrupt in the subprocess.
        with tempfile.NamedTemporaryFile(
            mode="w",
            suffix=".py",
            delete=False,
            encoding="utf-8",
            dir=tempfile.gettempdir(),
        ) as tmp:
            tmp.write(modified_source)
            tmp_path = tmp.name
            assert isinstance(tmp_path, str) and len(tmp_path) > 0
            assert os.path.isfile(tmp_path), f"Temp script missing after write: {tmp_path}"

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
        final_output_payload: dict[str, Any] | None = None
        stdout_fd = process.stdout.fileno()
        # Incomplete last line held across reads so a multi-chunk
        # __FINAL_OUTPUT__:<json> is never split into token events.
        stdout_carry: str = ""

        # Read stdout in real time — os.read returns whatever bytes are
        # available without waiting to fill the buffer.
        while True:
            data = os.read(stdout_fd, _STDOUT_READ_SIZE)
            if not data:
                break
            text = data.decode("utf-8", errors="replace")
            full_output.append(text)
            stdout_carry += text

            visible_parts: list[str] = []
            while True:
                newline_at = stdout_carry.find("\n")
                if newline_at < 0:
                    break
                line = stdout_carry[: newline_at + 1]
                stdout_carry = stdout_carry[newline_at + 1 :]
                stripped = line.strip()
                if stripped.startswith(_FINAL_OUTPUT_MARKER):
                    parsed = _parse_final_output_marker_line(stripped)
                    if parsed is not None:
                        final_output_payload = parsed
                else:
                    visible_parts.append(line)

            # Flush partial text only when it cannot be a FINAL_OUTPUT line.
            # Hold prefixes of the marker and any line that already started
            # with the marker until the terminating newline arrives.
            if stdout_carry and not _is_final_output_line_prefix(stdout_carry):
                visible_parts.append(stdout_carry)
                stdout_carry = ""

            visible_text = "".join(visible_parts)
            if visible_text:
                yield _build_sse_line({"event": "token", "token": visible_text})

        # EOF: resolve any trailing line that never received a newline.
        if stdout_carry:
            stripped = stdout_carry.strip()
            if stripped.startswith(_FINAL_OUTPUT_MARKER):
                parsed = _parse_final_output_marker_line(stripped)
                if parsed is not None:
                    final_output_payload = parsed
            elif stripped:
                yield _build_sse_line({"event": "token", "token": stdout_carry})

        process.wait()

        output_text = "".join(full_output).strip()
        # Strip marker lines from the human-readable output_text
        output_text = "\n".join(
            line for line in output_text.splitlines()
            if not line.strip().startswith(_FINAL_OUTPUT_MARKER)
        ).strip()

        if process.returncode != 0:
            stderr_text = process.stderr.read().decode("utf-8", errors="replace")
            yield _build_sse_line({
                "event": "error",
                "detail": stderr_text or f"Script exited with code {process.returncode}",
            })
        else:
            # Build the complete event payload.  If the script emitted a
            # __FINAL_OUTPUT__ marker, include all those fields (audio base64,
            # mimetype, URLs, etc.) so the frontend can play the audio.
            complete_payload: dict[str, Any] = {
                "event": "complete",
                "status": "success",
                "final_output": {"output": output_text},
            }
            if final_output_payload is not None:
                # Merge the rich payload: keep "output" as text fallback
                # but add all audio and metadata fields.
                complete_payload["final_output"].update(final_output_payload)
            yield _build_sse_line(complete_payload)

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
@app.websocket(f"{_API_PREFIX}/api/audio/stream/{{stream_id}}")
async def audio_stream_proxy(websocket: WebSocket, stream_id: str) -> None:
    """Accept browser binary audio frames and relay them to the upstream
    audio-streams WebSocket endpoint in real time.

    The browser:
      1. Opens this WS first (before calling /odisha/api/audio/execute).
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
    meta = _get_script_metadata()
    base_url = meta.base_url
    assert base_url, "BASE_URL not found in script.py — cannot proxy audio WebSocket"

    # Obtain or create a session so we can pass session_id in the WS handshake.
    # The upstream audio-streams endpoint requires both workflow_id and session_id
    # as query parameters when authenticating with X-Workflow-Key.
    client_id = str(websocket.client.host) if websocket.client else "default"
    session_id = _SESSIONS.get(client_id)
    if not session_id:
        try:
            sess_resp = requests.post(
                f"{base_url}/sessions",
                json={"workflow_id": meta.workflow_id, "name": "Audio session"},
                headers={"X-Workflow-Key": meta.workflow_key},
                timeout=15,
            )
            sess_resp.raise_for_status()
            session_id = sess_resp.json()["session_id"]
            _SESSIONS[client_id] = session_id
        except Exception as exc:
            await websocket.accept()
            await websocket.send_text(json.dumps({"event": "error", "detail": f"Session creation failed: {exc}"}))
            await websocket.close()
            return

    upstream_url = (
        f"{base_url.replace('https://', 'wss://').replace('http://', 'ws://')}"
        f"/audio-streams/{stream_id}"
        f"?workflow_id={meta.workflow_id}&session_id={session_id}"
    )
    auth_headers = {"X-Workflow-Key": meta.workflow_key}

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


@app.post(f"{_API_PREFIX}/api/audio/execute")
async def audio_execute(request: Request, stream_id: str = Form(...)) -> StreamingResponse:
    """Fire POST /execute/stream with stream_refs pointing at ``stream_id``.

    Call this *after* opening the ``/odisha/api/audio/stream/{stream_id}`` WebSocket
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
        # Step 1: Introspect script.py for dynamic credentials and stream var name
        meta = _get_script_metadata()
        assert meta.base_url, "BASE_URL not found in script.py"

        # Step 2: Obtain or reuse session
        session_id = _SESSIONS.get(client_id)
        if not session_id:
            sess_resp = requests.post(
                f"{meta.base_url}/sessions",
                json={"workflow_id": meta.workflow_id, "name": "Audio session"},
                headers={"X-Workflow-Key": meta.workflow_key},
                timeout=15,
            )
            sess_resp.raise_for_status()
            session_id = sess_resp.json()["session_id"]
            _SESSIONS[client_id] = session_id

        # Step 3: Resolve stream_refs key from stream_refs or files={...} in script.py.
        # Paradigm publish snippets expose audio_stream as files={"query": ...},
        # not as a stream_refs literal — never invent a hardcoded var name.
        stream_var_name: str = resolve_audio_stream_var_name(meta)
        assert stream_var_name, "stream_var_name must be non-empty"
        assert isinstance(stream_id, str) and stream_id, "stream_id must be non-empty"

        # Step 4: Fire execute/stream with stream_refs pointing at the live audio queue
        resp = requests.post(
            f"{meta.base_url}/execute/stream",
            data={
                "inputs": json.dumps({}),
                "stream_refs": json.dumps({stream_var_name: stream_id}),
                "workflow_id": meta.workflow_id,
                "session_id": session_id,
            },
            headers={"X-Workflow-Key": meta.workflow_key},
            stream=True,
            timeout=120,
        )
        _raise_for_upstream_status(resp, "audio execute/stream")

        # Step 5: Relay SSE events from upstream to browser.
        # Handles both text (token) and audio (audio_chunk) output workflows.
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
            elif ev == "audio_chunk":
                # Forward audio chunk with its base64 PCM16 payload and sample rate
                yield _build_sse_line({
                    "event": "audio_chunk",
                    "data_b64": event.get("data_b64", ""),
                    "sample_rate": event.get("sample_rate", 24000),
                    "node_id": event.get("node_id", ""),
                })
            elif ev == "complete":
                final_output = event.get("final_output", {})
                # Include the full final_output from upstream so the frontend
                # receives audio_file_output_b64, mimetype, and URLs if present.
                text_fallback = final_output.get("output") or "".join(token_buffer)
                complete_payload = final_output.copy()
                complete_payload.setdefault("output", text_fallback)
                yield _build_sse_line({
                    "event": "complete",
                    "status": "success",
                    "final_output": complete_payload,
                })
            elif ev == "error":
                yield _build_sse_line({"event": "error", "detail": event.get("detail", "Audio workflow error")})

        yield "data: [DONE]\n\n"

    except Exception as exc:
        yield _build_sse_line({"event": "error", "detail": f"{type(exc).__name__}: {exc}"})
        yield "data: [DONE]\n\n"


# ── Chat Streaming ────────────────────────────────────────────────────────
@app.post(f"{_API_PREFIX}/api/chat/stream")
async def chat_stream(
    request: Request,
    query: str = Form(default=""),
    file: UploadFile | None = File(default=None),
) -> StreamingResponse:
    """Run script.py with text and/or an uploaded audio file; stream SSE.

    Dual-input turns
    ----------------
    * Text: non-empty ``query``, optional document attach.
    * Voice file: empty ``query`` + audio ``file`` (mic recording as WAV) bound
      to the multipart Start variable name discovered from ``script.py``.
    """
    assert isinstance(query, str), "query must be a string"

    client_id = request.client.host if request.client else "default"

    uploaded_path: str | None = None
    if file is not None and file.filename:
        suffix = os.path.splitext(file.filename)[1] or ".wav"
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            body = await file.read()
            assert isinstance(body, (bytes, bytearray)), "upload body must be bytes"
            if len(body) == 0:
                raise ValueError("Uploaded audio/file is empty")
            tmp.write(body)
            uploaded_path = tmp.name

    if not query.strip() and uploaded_path is None:
        raise ValueError("Provide a text query and/or an uploaded audio/file")

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
