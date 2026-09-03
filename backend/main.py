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

import json
import os
import subprocess
import tempfile
import traceback
from typing import Any

from fastapi import FastAPI, File, Form, UploadFile, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
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
            ["python", tmp_path],
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


# ── Static frontend ──────────────────────────────────────────────────────
app.mount("/", StaticFiles(directory="../frontend", html=True), name="frontend")
