"""script_transformer.py — AST-based introspection and rewriting for Paradigm Platform scripts.

This module handles two concerns:

1. **Introspection** (``inspect_script``): Parses ``script.py`` without executing it
   and extracts structured metadata — workflow credentials, input variable names,
   file variable names, audio stream variable name, and whether the workflow
   emits audio chunks.

2. **Rewriting** (``rewrite_script``): Transforms the parsed AST to inject the
   caller's values (query, session ID, file paths) so the script can be executed
   verbatim by a subprocess.
"""
from __future__ import annotations

import ast
import json
import logging
import re
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)

# Paradigm publish snippets often leave multipart examples commented out.
_RE_FILES_DICT_KEY = re.compile(
    r"""files\s*=\s*\{\s*['"]([^'"]+)['"]""",
    re.MULTILINE,
)
_RE_ATTACH_VAR_COMMENT = re.compile(
    r"""attach a file for variable\s+['"]([^'"]+)['"]""",
    re.IGNORECASE,
)
_RE_STREAM_REFS_INLINE = re.compile(
    r"""['"]stream_refs['"]\s*:\s*json\.dumps\(\{\s*['"]([^'"]+)['"]""",
)

# ── Constants ──────────────────────────────────────────────────────────────────

# Paradigm Platform canonical names for input variables whose value is a text query.
_QUERY_VAR_PRIORITY: tuple[str, ...] = (
    "query", "question", "prompt", "text", "user_input", "message",
)

_SESSION_VAR_NAME: str = "session_id"
_STREAM_REFS_VAR_NAME: str = "stream_refs"
_FINAL_OUTPUT_VAR_NAME: str = "final_output"

# Must match ``main._FINAL_OUTPUT_MARKER`` — stdout bridge for rich final_output.
_FINAL_OUTPUT_MARKER: str = "__FINAL_OUTPUT__:"

# Variable names that indicate the workflow returns a discrete audio file in final_output.
_AUDIO_FILE_OUTPUT_VARS: frozenset[str] = frozenset({
    "audio_file_output",
    "audio_output",
    "speech_output",
    "tts_output",
})


# ── Data classes ───────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class ScriptMetadata:
    """Structured metadata extracted from a Paradigm Platform script.py.

    Attributes
    ----------
    workflow_key : str
        The X-Workflow-Key authentication token embedded in the script.
    workflow_id : str
        The UUID of the published workflow.
    base_url : str
        The API base URL (e.g. ``https://map-qa.paradigmit.ai/api/v1/agent-workflows``).
    caller_input_keys : list[str]
        Ordered list of text input variable names in the ``inputs`` dict.
    file_var_names : list[str]
        Names of file-upload variables found in ``files={...}`` call arguments.
        Paradigm publishes ``audio_stream`` Start variables as file uploads in
        the downloadable snippet (e.g. ``files={"query": ...}``).
    audio_stream_var_name : str | None
        The key inside ``stream_refs`` that names the audio_stream Start variable,
        or ``None`` when the script only declares the variable via ``files={...}``.
    has_audio_output : bool
        True when the script's SSE loop handles ``audio_chunk`` events.
    has_audio_file_output : bool
        True when the script assigns a known audio file output variable from
        ``final_output`` (e.g. ``audio_file_output = final_output[...]``).
    """
    workflow_key: str = ""
    workflow_id: str = ""
    base_url: str = ""
    caller_input_keys: list[str] = field(default_factory=list)
    file_var_names: list[str] = field(default_factory=list)
    audio_stream_var_name: str | None = None
    has_audio_output: bool = False
    has_audio_file_output: bool = False


# ── AST helpers ────────────────────────────────────────────────────────────────

def _const_value(node: ast.expr) -> Optional[str]:
    """Return the string value of an AST constant node, or None.

    Parameters
    ----------
    node : ast.expr
        Any AST expression node.

    Returns
    -------
    str | None
        The string value, or ``None`` if the node is not a string constant.
    """
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None


def _extract_dict_str_keys(dict_node: ast.Dict) -> list[str]:
    """Return all string keys from an ast.Dict node in order.

    Parameters
    ----------
    dict_node : ast.Dict
        A dict literal node from the AST.

    Returns
    -------
    list[str]
        String keys in declaration order.
    """
    assert isinstance(dict_node, ast.Dict), "Expected ast.Dict node"
    return [v for key in dict_node.keys if (v := _const_value(key)) is not None]


# ── Introspection ─────────────────────────────────────────────────────────────

class _MetadataExtractor(ast.NodeVisitor):
    """Single-pass AST visitor that collects all ScriptMetadata fields."""

    def __init__(self) -> None:
        self.workflow_key: str = ""
        self.workflow_id: str = ""
        self.base_url: str = ""
        self.caller_input_keys: list[str] = []
        self.file_var_names: list[str] = []
        self.audio_stream_var_name: str | None = None
        self.has_audio_output: bool = False
        self.has_audio_file_output: bool = False

    def visit_Assign(self, node: ast.Assign) -> None:  # noqa: N802
        """Capture top-level constant assignments and inputs/stream_refs dicts."""
        if len(node.targets) != 1 or not isinstance(node.targets[0], ast.Name):
            self.generic_visit(node)
            return

        name = node.targets[0].id
        value = node.value

        if name == "WORKFLOW_KEY":
            self.workflow_key = _const_value(value) or self.workflow_key
        elif name == "WORKFLOW_ID":
            self.workflow_id = _const_value(value) or self.workflow_id
        elif name == "BASE_URL":
            self.base_url = _const_value(value) or self.base_url
        elif name == "inputs" and isinstance(value, ast.Dict):
            self.caller_input_keys = _extract_dict_str_keys(value)
        elif name == _STREAM_REFS_VAR_NAME and isinstance(value, ast.Dict):
            keys = _extract_dict_str_keys(value)
            if keys:
                self.audio_stream_var_name = keys[0]
        elif name in _AUDIO_FILE_OUTPUT_VARS:
            # e.g. audio_file_output = final_output["audio_file_output"]
            self.has_audio_file_output = True

        self.generic_visit(node)

    def visit_keyword(self, node: ast.keyword) -> None:  # noqa: N802
        """Detect files={...} keyword arguments in requests.post calls."""
        if node.arg == "files" and isinstance(node.value, ast.Dict):
            for key in node.value.keys:
                k = _const_value(key)
                if k:
                    self.file_var_names.append(k)
        self.generic_visit(node)

    def visit_Compare(self, node: ast.Compare) -> None:  # noqa: N802
        """Detect ev == "audio_chunk" comparisons in the SSE loop."""
        for comparator in node.comparators:
            if _const_value(comparator) == "audio_chunk":
                self.has_audio_output = True
                break
        self.generic_visit(node)


def _file_var_names_from_source_text(script_source: str) -> list[str]:
    """Discover multipart Start-variable names from script text (incl. comments).

    Paradigm exports often comment the ``files={"<var>": ...}`` example instead
    of leaving it active. AST visit misses those; this recovers the declared
    variable name without hardcoding it.

    Parameters
    ----------
    script_source : str
        Full ``script.py`` source.

    Returns
    -------
    list[str]
        Unique names in first-seen order.
    """
    assert isinstance(script_source, str) and script_source, "script_source required"
    found: list[str] = []
    for match in _RE_FILES_DICT_KEY.finditer(script_source):
        name = match.group(1).strip()
        if name:
            found.append(name)
    for match in _RE_ATTACH_VAR_COMMENT.finditer(script_source):
        name = match.group(1).strip()
        if name:
            found.append(name)
    return list(dict.fromkeys(found))


def inspect_script(script_source: str) -> ScriptMetadata:
    """Parse script_source and extract all metadata without executing it.

    Multipart file / audio Start variable names are taken from active
    ``files={...}`` AST nodes first, then from commented Paradigm snippets in
    the same file (never hardcoded).

    Parameters
    ----------
    script_source : str
        Full source text of script.py as read from disk.

    Returns
    -------
    ScriptMetadata
        Extracted credentials, input names, and streaming flags.

    Raises
    ------
    SyntaxError
        If script_source is not valid Python.
    ValueError
        If no WORKFLOW_KEY or WORKFLOW_ID is found in the source.
    """
    assert isinstance(script_source, str) and script_source, \
        "script_source must be a non-empty string"

    tree = ast.parse(script_source)
    extractor = _MetadataExtractor()
    extractor.visit(tree)

    # Fallback for scripts that define stream_refs inline (e.g. within a client.stream call)
    if extractor.audio_stream_var_name is None:
        m = _RE_STREAM_REFS_INLINE.search(script_source)
        if m:
            extractor.audio_stream_var_name = m.group(1)

    file_var_names = _rank_audio_input_var_names(
        list(dict.fromkeys(
            extractor.file_var_names + _file_var_names_from_source_text(script_source)
        ))
    )
    assert isinstance(file_var_names, list)

    if not extractor.workflow_key or not extractor.workflow_id:
        raise ValueError(
            "Missing WORKFLOW_KEY or WORKFLOW_ID in script.py. "
            "Please ensure the file is a valid Paradigm Platform script."
        )

    return ScriptMetadata(
        workflow_key=extractor.workflow_key,
        workflow_id=extractor.workflow_id,
        base_url=extractor.base_url,
        caller_input_keys=extractor.caller_input_keys,
        file_var_names=file_var_names,
        audio_stream_var_name=extractor.audio_stream_var_name,
        has_audio_output=extractor.has_audio_output,
        has_audio_file_output=extractor.has_audio_file_output,
    )


def _rank_audio_input_var_names(names: list[str]) -> list[str]:
    """Order multipart names so live audio *inputs* beat TTS *outputs*.

    Paradigm comments often list both ``audio_file_output`` (End/TTS) and
    ``audio_input_stream`` (Start/STT). Live mic must use the stream/input name.

    Parameters
    ----------
    names : list[str]
        Candidate Start/multipart variable names from ``script.py``.

    Returns
    -------
    list[str]
        Deduplicated names: stream/input-like first, then other non-outputs,
        then known audio-file output names last.
    """
    assert isinstance(names, list), "names must be a list"
    streamish: list[str] = []
    other: list[str] = []
    outputs: list[str] = []
    for raw in names:
        assert isinstance(raw, str), "each name must be a string"
        name = raw.strip()
        if not name:
            continue
        lower = name.lower()
        if name in _AUDIO_FILE_OUTPUT_VARS or lower.endswith("_output"):
            outputs.append(name)
        elif "stream" in lower or "input" in lower:
            streamish.append(name)
        else:
            other.append(name)
    return list(dict.fromkeys(streamish + other + outputs))


def resolve_audio_stream_var_name(meta: ScriptMetadata) -> str:
    """Return the Start-variable name to use in ``stream_refs`` for live mic audio.

    Paradigm Platform publish snippets treat ``audio_stream`` inputs as multipart
    file uploads (``files={"query": ...}``) and do **not** emit a ``stream_refs``
    dict. Live execution still requires ``stream_refs={var_name: stream_id}``
    where ``var_name`` matches that Start variable.

    Resolution order
    ----------------
    1. Explicit ``stream_refs`` key from the script (``meta.audio_stream_var_name``).
    2. Ranked multipart names from ``files={...}`` / comments — prefer names
       containing ``stream`` or ``input`` over TTS output names like
       ``audio_file_output``.

    Parameters
    ----------
    meta : ScriptMetadata
        Metadata produced by ``inspect_script``.

    Returns
    -------
    str
        Non-empty Start variable name for ``stream_refs``.

    Raises
    ------
    ValueError
        If the script declares neither ``stream_refs`` nor a ``files={...}``
        multipart variable — live mic cannot be mapped to a workflow input.
    TypeError
        If ``meta`` is not a ``ScriptMetadata`` instance.
    """
    assert isinstance(meta, ScriptMetadata), "meta must be a ScriptMetadata instance"

    if meta.audio_stream_var_name:
        name = meta.audio_stream_var_name.strip()
        assert name, "audio_stream_var_name must be non-empty when set"
        return name

    ranked = _rank_audio_input_var_names(list(meta.file_var_names))
    if ranked:
        name = ranked[0]
        assert name, "ranked audio input name must be non-empty"
        return name

    raise ValueError(
        "Cannot resolve live-audio stream_refs variable: script.py has neither "
        "a stream_refs dict nor a files={...} multipart variable. Re-export a "
        "workflow whose Start node declares an audio_stream (or audio_file) input."
    )


# ── Rewriting ─────────────────────────────────────────────────────────────────

class _ScriptRewriter(ast.NodeTransformer):
    """AST transformer that injects runtime values into the generated script.

    Parameters
    ----------
    query : str
        Text from the user to inject into the ``inputs`` dict.
    session_id : str | None
        Existing session ID to reuse, or ``None`` to let the script create one.
    files : dict[str, str] | None
        Mapping from file variable name to its temporary local path.
    meta : ScriptMetadata
        Pre-extracted metadata from ``inspect_script``.
    """

    def __init__(
        self,
        query: str,
        session_id: str | None,
        files: dict[str, str] | None,
        meta: ScriptMetadata,
    ) -> None:
        assert isinstance(query, str), "query must be a string"
        self.files: dict[str, str] = files or {}
        # Voice-file STT path: empty query + multipart audio — leave inputs {}.
        # Text path: non-empty query required.
        assert query.strip() or self.files, (
            "query must be non-empty for text turns, or files must be set for voice-file turns"
        )
        self.query = query
        self.session_id = session_id
        self.meta = meta
        self.inject_text_query = bool(query.strip())
        self.replaced_query = not self.inject_text_query  # voice-file: nothing to inject
        self.bypassed_session = False
        self.emitted_final_output = False
        self.saw_multipart_files_kw = False
        self.injected_multipart_wrapper = False

    def _build_final_output_emit_stmt(self) -> ast.Expr:
        """Build ``print("__FINAL_OUTPUT__:" + json.dumps(final_output), flush=True)``.

        Returns
        -------
        ast.Expr
            Expression statement the parent process parses from subprocess stdout.
        """
        marker = ast.Constant(value=_FINAL_OUTPUT_MARKER)
        dumps_call = ast.Call(
            func=ast.Attribute(
                value=ast.Name(id="json", ctx=ast.Load()),
                attr="dumps",
                ctx=ast.Load(),
            ),
            args=[ast.Name(id=_FINAL_OUTPUT_VAR_NAME, ctx=ast.Load())],
            keywords=[],
        )
        print_call = ast.Call(
            func=ast.Name(id="print", ctx=ast.Load()),
            args=[ast.BinOp(left=marker, op=ast.Add(), right=dumps_call)],
            keywords=[ast.keyword(arg="flush", value=ast.Constant(value=True))],
        )
        stmt = ast.Expr(value=print_call)
        assert isinstance(stmt, ast.Expr)
        assert isinstance(stmt.value, ast.Call)
        return stmt

    def _soften_final_output_subscript(self, node: ast.Assign) -> None:
        """Rewrite ``audio_file_output = final_output["k"]`` to ``.get("k")``.

        Published snippets KeyError when Paradigm only returns
        ``audio_file_output_b64`` / ``_public_url`` without the bare key.
        Softening lets the ``__FINAL_OUTPUT__`` emit still run.

        Parameters
        ----------
        node : ast.Assign
            Assignment whose RHS may be a ``final_output[...]`` subscript.
        """
        assert isinstance(node, ast.Assign)
        value = node.value
        if not isinstance(value, ast.Subscript):
            return
        if not isinstance(value.value, ast.Name) or value.value.id != _FINAL_OUTPUT_VAR_NAME:
            return
        key = _const_value(value.slice)
        if key is None:
            return
        node.value = ast.Call(
            func=ast.Attribute(
                value=ast.Name(id=_FINAL_OUTPUT_VAR_NAME, ctx=ast.Load()),
                attr="get",
                ctx=ast.Load(),
            ),
            args=[ast.Constant(value=key)],
            keywords=[],
        )

    def _call_url_contains(self, call: ast.Call, needle: str) -> bool:
        """Return True when the first positional URL arg contains ``needle``."""
        assert isinstance(call, ast.Call)
        assert isinstance(needle, str) and needle
        if not call.args:
            return False
        arg0 = call.args[0]
        if isinstance(arg0, ast.Constant) and isinstance(arg0.value, str):
            return needle in arg0.value
        if isinstance(arg0, ast.JoinedStr):
            for part in arg0.values:
                if (
                    isinstance(part, ast.Constant)
                    and isinstance(part.value, str)
                    and needle in part.value
                ):
                    return True
        return False

    def _is_execute_stream_post(self, call: ast.Call) -> bool:
        """Return True when ``call`` is ``requests.post(.../execute/stream)``."""
        assert isinstance(call, ast.Call)
        func = call.func
        if not (isinstance(func, ast.Attribute) and func.attr == "post"):
            return False
        return self._call_url_contains(call, "execute")

    def _wrap_post_assign_with_upload(self, assign: ast.Assign) -> ast.With:
        """Wrap ``resp = requests.post(...)`` in ``with open(path) as <var>_f`` + files=.

        Uses the Start-variable name from ``self.files`` (discovered from script.py),
        never a hardcoded name.

        Parameters
        ----------
        assign : ast.Assign
            Assignment whose value is the execute/stream POST call.

        Returns
        -------
        ast.With
            ``with open(...) as handle:`` containing the patched assignment.
        """
        assert isinstance(assign, ast.Assign)
        assert isinstance(assign.value, ast.Call)
        assert self.files, "files map required to wrap upload"
        var_name, path = next(iter(self.files.items()))
        assert isinstance(var_name, str) and var_name, "file Start var name required"
        assert isinstance(path, str) and path, "upload path required"

        handle = f"{var_name}_f"
        call = assign.value
        # Drop any stale files= then attach the discovered Start var.
        call.keywords = [kw for kw in call.keywords if kw.arg != "files"]
        call.keywords.append(
            ast.keyword(
                arg="files",
                value=ast.Dict(
                    keys=[ast.Constant(value=var_name)],
                    values=[ast.Name(id=handle, ctx=ast.Load())],
                ),
            )
        )
        self.saw_multipart_files_kw = True
        self.injected_multipart_wrapper = True
        return ast.With(
            items=[
                ast.withitem(
                    context_expr=ast.Call(
                        func=ast.Name(id="open", ctx=ast.Load()),
                        args=[ast.Constant(value=path), ast.Constant(value="rb")],
                        keywords=[],
                    ),
                    optional_vars=ast.Name(id=handle, ctx=ast.Store()),
                )
            ],
            body=[assign],
        )

    def visit_Assign(self, node: ast.Assign) -> ast.AST | list[ast.AST]:  # noqa: N802
        """Rewrite inputs, session_id, file upload wrapper, and final_output emit."""
        if len(node.targets) != 1 or not isinstance(node.targets[0], ast.Name):
            return self.generic_visit(node)

        name = node.targets[0].id
        value = node.value

        if name == "inputs" and isinstance(value, ast.Dict):
            if self.inject_text_query:
                self._inject_query_into_dict(value)
            return node

        if name == _SESSION_VAR_NAME and self.session_id and not self.bypassed_session:
            self.bypassed_session = True
            node.value = ast.Constant(value=self.session_id)
            return node

        if name in _AUDIO_FILE_OUTPUT_VARS:
            self._soften_final_output_subscript(node)
            return node

        if name == _FINAL_OUTPUT_VAR_NAME:
            self.emitted_final_output = True
            return [node, self._build_final_output_emit_stmt()]

        # Voice upload when script has no active files={...}: inject open+files=
        # using the Start var name discovered from script.py (comments or AST).
        if (
            self.files
            and isinstance(value, ast.Call)
            and self._is_execute_stream_post(value)
            and not any(kw.arg == "files" for kw in value.keywords)
        ):
            return self._wrap_post_assign_with_upload(node)

        return self.generic_visit(node)

    def _inject_query_into_dict(self, dict_node: ast.Dict) -> None:
        """Mutate dict_node so ``self.query`` is sent as a text Start variable.

        Preference order: known query key names, ``"<value>"`` placeholders,
        first existing key. When ``inputs`` is empty (common for audio-export
        snippets), insert ``{"query": <text>}`` so dual text/audio workflows
        can take the Condition branch that skips STT.

        Parameters
        ----------
        dict_node : ast.Dict
            The inputs dict literal to mutate in-place.
        """
        assert isinstance(dict_node, ast.Dict), "Expected ast.Dict"
        assert isinstance(self.query, str) and self.query, "query must be non-empty"
        best_idx: int = -1

        # Pass 1 — priority key names
        for priority_name in _QUERY_VAR_PRIORITY:
            for idx, key in enumerate(dict_node.keys):
                if _const_value(key) == priority_name:
                    best_idx = idx
                    break
            if best_idx != -1:
                break

        # Pass 2 — any "<value>" placeholder value
        if best_idx == -1:
            for idx, val in enumerate(dict_node.values):
                if _const_value(val) == "<value>":
                    best_idx = idx
                    break

        # Pass 3 — fallback: first key
        if best_idx == -1 and dict_node.keys:
            best_idx = 0

        if best_idx != -1:
            dict_node.values[best_idx] = ast.Constant(value=self.query)
            self.replaced_query = True
            return

        # Pass 4 — empty inputs dict: add the canonical text Start variable
        query_key = _QUERY_VAR_PRIORITY[0]
        assert query_key == "query", "canonical text Start var must be 'query'"
        dict_node.keys.append(ast.Constant(value=query_key))
        dict_node.values.append(ast.Constant(value=self.query))
        self.replaced_query = True

    def _is_multipart_open_with(self, node: ast.With) -> bool:
        """Return True when ``node`` is ``with open(...) as ...`` for file upload.

        Parameters
        ----------
        node : ast.With
            A ``with`` statement from the script AST.

        Returns
        -------
        bool
            True if the context manager is a builtin ``open(...)`` call.
        """
        assert isinstance(node, ast.With), "Expected ast.With"
        if len(node.items) != 1:
            return False
        ctx = node.items[0].context_expr
        return (
            isinstance(ctx, ast.Call)
            and isinstance(ctx.func, ast.Name)
            and ctx.func.id == "open"
        )

    def visit_With(self, node: ast.With) -> ast.AST | list[ast.AST]:  # noqa: N802
        """On text-only runs, unwrap ``with open(...)`` used solely for multipart.

        Dual-input workflows may declare ``files={...}`` even when the caller
        only has chat text. Without a local upload path we drop the open/files
        wiring so execute/stream receives ``inputs={"query": ...}`` alone.
        """
        assert isinstance(node, ast.With), "Expected ast.With"
        if not self.files and self._is_multipart_open_with(node):
            rewritten: list[ast.AST] = []
            for stmt in node.body:
                visited = self.visit(stmt)
                if isinstance(visited, list):
                    rewritten.extend(visited)
                else:
                    rewritten.append(visited)
            assert len(rewritten) >= 1, "unwrapped with-body must not be empty"
            return rewritten
        return self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> ast.AST:  # noqa: N802
        """Rewrite open() paths when uploading; strip files= on text-only runs."""
        assert isinstance(node, ast.Call), "Expected ast.Call"
        if (
            isinstance(node.func, ast.Name)
            and node.func.id == "open"
            and len(node.args) >= 1
            and isinstance(node.args[0], ast.Constant)
            and self.files
        ):
            first_path = next(iter(self.files.values()))
            assert isinstance(first_path, str) and first_path, "file path must be non-empty"
            node.args[0] = ast.Constant(value=first_path)

        visited = self.generic_visit(node)
        assert isinstance(visited, ast.Call), "visit_Call must return ast.Call"

        if any(kw.arg == "files" for kw in visited.keywords):
            self.saw_multipart_files_kw = True

        # Text-only: remove multipart files= so STT Start vars stay unset.
        if not self.files:
            visited.keywords = [kw for kw in visited.keywords if kw.arg != "files"]
        return visited


def rewrite_script(
    script_source: str,
    query: str,
    session_id: Optional[str] = None,
    files: Optional[dict[str, str]] = None,
) -> str:
    """Inject runtime values into script_source and return the modified source.

    Text-only (``files`` empty/omitted)
        Injects ``query`` into ``inputs`` (adding ``{"query": ...}`` when the
        dict is empty) and strips ``with open(...)/files={...}`` so dual-input
        workflows take the text Condition branch without attaching audio.

    With upload (``files`` provided)
        Rewrites ``open(...)`` paths to the temporary upload and keeps multipart.
        When ``query`` is empty, leaves ``inputs`` empty so dual-input Condition
        takes the STT/audio branch (mic record → WAV upload).

    Final output bridge
        After ``final_output = result["final_output"]``, emits
        ``print("__FINAL_OUTPUT__:" + json.dumps(final_output), flush=True)``
        so ``main._run_script_and_stream`` can forward audio b64/URL fields to
        the browser. Softens ``audio_file_output = final_output["..."]`` to
        ``.get(...)`` so missing bare keys do not abort before the emit.

    Parameters
    ----------
    script_source : str
        Full source text of script.py.
    query : str
        User's text input to inject into the ``inputs`` dict. May be empty when
        ``files`` is provided (voice-file STT turn).
    session_id : str | None
        If provided, replaces the session_id assignment to reuse an existing
        platform session instead of creating a new one.
    files : dict[str, str] | None
        Maps file variable names to temporary local paths on disk. Omit or
        pass ``None``/``{}`` for text-only dual-input turns.

    Returns
    -------
    str
        Modified Python source ready to be written to a temp file and executed.

    Raises
    ------
    SyntaxError
        If script_source is not valid Python.
    ValueError
        If the script is missing required Paradigm Platform constants, query
        injection fails, or ``final_output`` cannot be bridged to stdout.
    """
    assert isinstance(script_source, str) and script_source, \
        "script_source must be non-empty"
    assert isinstance(query, str), "query must be a string"
    files_map: dict[str, str] = files or {}
    if not query.strip() and not files_map:
        raise ValueError(
            "rewrite_script requires a non-empty query and/or a files map"
        )
    if files is not None:
        assert isinstance(files, dict), "files must be a dict when provided"

    meta = inspect_script(script_source)
    if files_map and not meta.file_var_names:
        raise ValueError(
            "An audio/file upload was provided, but script.py declares no "
            "files={...} multipart Start variable (active or in comments)."
        )

    # Ensure rewrite uses the script-discovered Start var name as the map key.
    if files_map:
        discovered = meta.file_var_names[0]
        assert isinstance(discovered, str) and discovered, "discovered file var empty"
        upload_path = next(iter(files_map.values()))
        assert isinstance(upload_path, str) and upload_path, "upload path empty"
        files_map = {discovered: upload_path}
        files = files_map

    tree = ast.parse(script_source)
    rewriter = _ScriptRewriter(query=query, session_id=session_id, files=files, meta=meta)
    new_tree = rewriter.visit(tree)
    ast.fix_missing_locations(new_tree)

    new_source: str = ast.unparse(new_tree)
    assert isinstance(new_source, str) and new_source, "unparse must yield non-empty source"

    # String-replace fallback for rare cases where inputs dict is not a static literal
    if rewriter.inject_text_query and not rewriter.replaced_query and '"<value>"' in new_source:
        new_source = new_source.replace('"<value>"', json.dumps(query))
        rewriter.replaced_query = True
        logger.warning(
            "rewrite_script: fell back to string-replace for query injection — "
            "inputs dict may not be a static literal."
        )

    if rewriter.inject_text_query and not rewriter.replaced_query:
        raise ValueError(
            "Failed to inject text query into script.py inputs dict. "
            "Ensure the script assigns inputs = {} or inputs = {\"query\": ...}."
        )

    if files_map and "files=" not in new_source:
        raise ValueError(
            "Voice-file rewrite kept no files= multipart on execute/stream; "
            f"cannot attach Start variable {meta.file_var_names[0]!r} from script.py."
        )

    if not rewriter.emitted_final_output or _FINAL_OUTPUT_MARKER not in new_source:
        raise ValueError(
            "Failed to bridge final_output to stdout. script.py must assign "
            "final_output = result[\"final_output\"] after the SSE loop."
        )

    return new_source
