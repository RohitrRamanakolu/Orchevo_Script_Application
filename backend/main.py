"""FastAPI backend that runs published Paradigm Platform workflows for the chatbot UI.

Credentials (WORKFLOW_KEY, WORKFLOW_ID, BASE_URL) and input names (text query,
audio Start variable) are introspected from ``script.py`` on every request via
``script_transformer.inspect_script``. ``script.py`` is never executed: the backend
creates/reuses a platform session and calls ``POST /execute/stream`` itself, so any
published client (linear snippet or CLI-style with ``create_session()``/``ask()``)
works as long as it declares the constants and the ``query`` / audio variables.
Dropping a new ``script.py`` reconfigures the backend without a restart.

Routes
------
APIs are mounted twice so both nginx (strip ``/odisha``) and local browsers work:

* After nginx strips ``/odisha``: ``/chat/stream``, ``/audio/execute``, …
* Direct / frontend: ``/odisha/chat/stream``, ``/odisha/audio/execute``, …

POST …/chat/stream           — text and/or file turn: call execute/stream, relay SSE.
POST …/audio/execute         — fire execute/stream with stream_refs, relay SSE.
WS   …/audio/stream/{id}     — proxy mic audio to upstream audio-streams WS.
GET  …/health-check          — health probe.
GET  /                       — serves chatbot.html.
"""
from __future__ import annotations

import asyncio
import json
import mimetypes
import os
import tempfile
import uuid
from collections.abc import Iterator
from typing import Any

import requests
import websockets

from fastapi import (
    APIRouter,
    FastAPI,
    File,
    Form,
    UploadFile,
    Request,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from script_transformer import (
    inspect_script,
    resolve_audio_stream_var_name,
    resolve_text_input_var_name,
    ScriptMetadata,
)

app = FastAPI(title="Chat Workflow Backend", version="1.0.0")

# Browser and frontend ENDPOINTS use this prefix (e.g. /odisha/chat/stream).
_PUBLIC_API_PREFIX: str = "/odisha"
# Same handlers also mount at "" so nginx can strip /odisha and forward /chat/stream.
_api_router = APIRouter()

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

# Max characters of an upstream error body to include in raised exceptions.
_UPSTREAM_ERROR_BODY_LIMIT: int = 500

# Seconds to wait for Paradigm session creation.
_UPSTREAM_SESSION_TIMEOUT_S: int = 15

# Seconds allowed between bytes on the execute/stream response (matches published clients).
_UPSTREAM_EXECUTE_TIMEOUT_S: int = 900

# Session labels shown in the Paradigm console, one per entry point.
_SESSION_NAME_CHAT: str = "Chat session"
_SESSION_NAME_AUDIO: str = "Audio session"

# Content type for uploads whose type cannot be guessed from the file name.
_DEFAULT_UPLOAD_MIMETYPE: str = "application/octet-stream"

# Sample rate (Hz) assumed for audio_chunk events that omit ``sample_rate``.
_DEFAULT_AUDIO_SAMPLE_RATE: int = 24000


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
@_api_router.get("/health-check")
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


def _session_cache_key(client_id: str, meta: ScriptMetadata) -> str:
    """Key the session cache by client AND workflow.

    Swapping ``script.py`` to a different workflow must not reuse a session that
    belongs to the previous workflow.

    Parameters
    ----------
    client_id : str
        Identifier of the browser client (its IP).
    meta : ScriptMetadata
        Metadata whose ``workflow_id`` scopes the session.

    Returns
    -------
    str
        ``"<client_id>:<workflow_id>"``.
    """
    assert isinstance(client_id, str) and client_id, "client_id must be non-empty"
    assert isinstance(meta, ScriptMetadata) and meta.workflow_id, "meta needs a workflow_id"
    return f"{client_id}:{meta.workflow_id}"


def _ensure_session_id(meta: ScriptMetadata, client_id: str, session_name: str) -> str:
    """Return the cached platform session for this client, creating one if needed.

    Parameters
    ----------
    meta : ScriptMetadata
        Credentials and ``base_url`` introspected from ``script.py``.
    client_id : str
        Identifier of the browser client (its IP).
    session_name : str
        Label for a newly created session.

    Returns
    -------
    str
        Paradigm ``session_id``.

    Raises
    ------
    RuntimeError
        If session creation is rejected (e.g. invalid or expired workflow key).
    """
    assert isinstance(session_name, str) and session_name, "session_name must be non-empty"
    assert meta.base_url, "BASE_URL not found in script.py"
    cache_key = _session_cache_key(client_id, meta)
    cached_session_id = _SESSIONS.get(cache_key)
    if cached_session_id:
        return cached_session_id

    resp = requests.post(
        f"{meta.base_url}/sessions",
        json={"workflow_id": meta.workflow_id, "name": session_name},
        headers={"X-Workflow-Key": meta.workflow_key},
        timeout=_UPSTREAM_SESSION_TIMEOUT_S,
    )
    _raise_for_upstream_status(resp, "session create")
    session_id = resp.json()["session_id"]
    assert isinstance(session_id, str) and session_id, "session_id must be a non-empty string"
    _SESSIONS[cache_key] = session_id
    return session_id


def _post_execute_stream(
    meta: ScriptMetadata,
    data: dict[str, str],
    files: dict[str, tuple[str, Any, str]] | None = None,
) -> requests.Response:
    """POST ``/execute/stream`` to Paradigm and return the open streaming response.

    Parameters
    ----------
    meta : ScriptMetadata
        Credentials and ``base_url`` introspected from ``script.py``.
    data : dict[str, str]
        Form fields (``inputs``, ``workflow_id``, ``session_id``, optional ``stream_refs``).
    files : dict | None
        Optional multipart upload ``{start_var: (filename, handle, mimetype)}``.

    Returns
    -------
    requests.Response
        Streaming response ready for ``iter_lines()``.

    Raises
    ------
    RuntimeError
        If Paradigm answers with a non-2xx status.
    """
    assert meta.base_url, "BASE_URL not found in script.py"
    assert "workflow_id" in data and "session_id" in data, "data needs workflow_id and session_id"
    resp = requests.post(
        f"{meta.base_url}/execute/stream",
        data=data,
        files=files,
        headers={"X-Workflow-Key": meta.workflow_key},
        stream=True,
        timeout=_UPSTREAM_EXECUTE_TIMEOUT_S,
    )
    _raise_for_upstream_status(resp, "execute/stream")
    return resp


def _relay_execute_stream(resp: requests.Response, cache_key: str) -> Iterator[str]:
    """Relay Paradigm ``execute/stream`` events to the browser as SSE lines.

    Handles text (``token``), streamed audio (``audio_chunk``) and the final
    payload (``complete``). The full ``final_output`` is forwarded so the UI can
    show ``output`` text and play ``audio_file_output_b64`` together.

    Parameters
    ----------
    resp : requests.Response
        Open streaming response from ``/execute/stream``.
    cache_key : str
        ``_SESSIONS`` key to refresh when the platform reports a session id.

    Yields
    ------
    str
        SSE ``data:`` lines. The caller appends ``data: [DONE]``.

    Raises
    ------
    RuntimeError
        If the upstream stream ends without a ``complete`` or ``error`` event.
    """
    assert resp is not None, "upstream response must not be None"
    assert isinstance(cache_key, str) and cache_key, "cache_key must be non-empty"
    token_buffer: list[str] = []
    finished = False
    for raw_line in resp.iter_lines():
        if not raw_line:
            continue
        line = raw_line.decode() if isinstance(raw_line, bytes) else raw_line
        if line == "data: [DONE]":
            break
        if not line.startswith("data:"):
            continue
        event = json.loads(line[5:].strip())
        event_name = event.get("event")
        if event_name == "session":
            new_session_id = event.get("session_id")
            if new_session_id:
                _SESSIONS[cache_key] = new_session_id
        elif event_name == "token":
            token_buffer.append(event.get("token", ""))
            yield _build_sse_line({"event": "token", "token": event.get("token", "")})
        elif event_name == "audio_chunk":
            yield _build_sse_line({
                "event": "audio_chunk",
                "data_b64": event.get("data_b64", ""),
                "sample_rate": event.get("sample_rate", _DEFAULT_AUDIO_SAMPLE_RATE),
                "node_id": event.get("node_id", ""),
            })
        elif event_name == "complete":
            finished = True
            final_output = dict(event.get("final_output") or {})
            final_output.setdefault("output", "".join(token_buffer))
            yield _build_sse_line({
                "event": "complete",
                "status": "success",
                "final_output": final_output,
            })
        elif event_name == "error":
            finished = True
            yield _build_sse_line({
                "event": "error",
                "detail": event.get("detail", "Workflow error"),
            })
    if not finished:
        raise RuntimeError("Workflow stream ended without a complete event")


def _run_chat_and_stream(
    query: str,
    client_id: str,
    uploaded_file_path: str | None = None,
) -> Iterator[str]:
    """Run the published workflow for a text and/or uploaded-file turn; yield SSE.

    ``script.py`` is only introspected (credentials, ``query`` variable, audio Start
    variable) — it is never executed. The backend creates/reuses a session and
    calls ``/execute/stream`` directly.

    Parameters
    ----------
    query : str
        Text for the workflow's text Start variable. May be empty for voice-file turns.
    client_id : str
        Identifier for the user, used to persist the session across turns.
    uploaded_file_path : str | None
        Temporary uploaded file bound to the audio Start variable. Deleted when done.

    Yields
    ------
    str
        SSE-formatted lines (``token`` / ``audio_chunk`` / ``complete`` / ``error`` / ``[DONE]``).
    """
    assert isinstance(query, str), "query must be a string"
    has_upload = isinstance(uploaded_file_path, str) and bool(uploaded_file_path)
    if not query.strip() and not has_upload:
        raise ValueError("Provide a text query and/or an uploaded audio/file")

    upload_handle = None
    try:
        meta = _get_script_metadata()
        session_id = _ensure_session_id(meta, client_id, _SESSION_NAME_CHAT)

        text_inputs: dict[str, str] = (
            {resolve_text_input_var_name(meta): query.strip()} if query.strip() else {}
        )
        form_data = {
            "inputs": json.dumps(text_inputs),
            "workflow_id": meta.workflow_id,
            "session_id": session_id,
        }

        upload_files: dict[str, tuple[str, Any, str]] | None = None
        if has_upload:
            assert uploaded_file_path is not None
            assert os.path.isfile(uploaded_file_path), f"upload missing: {uploaded_file_path}"
            file_name = os.path.basename(uploaded_file_path)
            mimetype = mimetypes.guess_type(file_name)[0] or _DEFAULT_UPLOAD_MIMETYPE
            upload_handle = open(uploaded_file_path, "rb")
            upload_files = {resolve_audio_stream_var_name(meta): (file_name, upload_handle, mimetype)}

        resp = _post_execute_stream(meta, form_data, upload_files)
        yield from _relay_execute_stream(resp, _session_cache_key(client_id, meta))
        yield "data: [DONE]\n\n"
    except Exception as exc:
        yield _build_sse_line({"event": "error", "detail": f"{type(exc).__name__}: {exc}"})
        yield "data: [DONE]\n\n"
    finally:
        if upload_handle is not None:
            upload_handle.close()
        if has_upload and uploaded_file_path:
            try:
                os.unlink(uploaded_file_path)
            except OSError:
                pass


# ── Audio WebSocket Proxy ────────────────────────────────────────────────
@_api_router.websocket("/audio/stream/{stream_id}")
async def audio_stream_proxy(websocket: WebSocket, stream_id: str) -> None:
    """Accept browser binary audio frames and relay them to the upstream
    audio-streams WebSocket endpoint in real time.

    The browser:
      1. Opens this WS first (before calling /odisha/audio/execute).
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
    try:
        session_id = _ensure_session_id(meta, client_id, _SESSION_NAME_AUDIO)
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


@_api_router.post("/audio/execute")
async def audio_execute(request: Request, stream_id: str = Form(...)) -> StreamingResponse:
    """Fire POST /execute/stream with stream_refs pointing at ``stream_id``.

    Call this *after* opening the ``/odisha/audio/stream/{stream_id}`` WebSocket
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


def _run_audio_and_stream(stream_id: str, client_id: str) -> Iterator[str]:
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
    assert isinstance(stream_id, str) and stream_id, "stream_id must be non-empty"
    try:
        meta = _get_script_metadata()
        session_id = _ensure_session_id(meta, client_id, _SESSION_NAME_AUDIO)

        # Paradigm publish snippets expose audio_stream as files={"<var>": ...}, not
        # as a stream_refs literal — the name is discovered, never hardcoded.
        stream_var_name = resolve_audio_stream_var_name(meta)
        form_data = {
            "inputs": json.dumps({}),
            "stream_refs": json.dumps({stream_var_name: stream_id}),
            "workflow_id": meta.workflow_id,
            "session_id": session_id,
        }
        resp = _post_execute_stream(meta, form_data)
        yield from _relay_execute_stream(resp, _session_cache_key(client_id, meta))
        yield "data: [DONE]\n\n"
    except Exception as exc:
        yield _build_sse_line({"event": "error", "detail": f"{type(exc).__name__}: {exc}"})
        yield "data: [DONE]\n\n"


# ── Chat Streaming ────────────────────────────────────────────────────────
@_api_router.post("/chat/stream")
async def chat_stream(
    request: Request,
    query: str = Form(default=""),
    file: UploadFile | None = File(default=None),
) -> StreamingResponse:
    """Run the workflow declared in script.py for a text and/or file turn; stream SSE.

    The backend calls Paradigm ``/execute/stream`` directly (``script.py`` supplies
    credentials and variable names only).

    Dual-input turns
    ----------------
    * Text: non-empty ``query`` sent as the text Start variable (e.g. ``query``).
    * Voice file: empty ``query`` + audio ``file`` (mic recording as WAV) bound
      to the multipart Start variable name discovered from ``script.py``.

    SSE events: ``token``, ``audio_chunk``, ``complete`` (``final_output`` with
    ``output`` text and, when present, ``audio_file_output_b64``), ``error``.
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
        _run_chat_and_stream(query, client_id, uploaded_path),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# Mount APIs at "" (nginx after strip) and under /odisha (local / browser).
assert _PUBLIC_API_PREFIX.startswith("/"), "_PUBLIC_API_PREFIX must start with /"
assert len(_PUBLIC_API_PREFIX) > 1, "_PUBLIC_API_PREFIX must not be empty"
app.include_router(_api_router)
app.include_router(_api_router, prefix=_PUBLIC_API_PREFIX)

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
