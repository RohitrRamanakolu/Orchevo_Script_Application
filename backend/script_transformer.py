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
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)

# ── Constants ──────────────────────────────────────────────────────────────────

# Paradigm Platform canonical names for input variables whose value is a text query.
_QUERY_VAR_PRIORITY: tuple[str, ...] = (
    "query", "question", "prompt", "text", "user_input", "message",
)

_SESSION_VAR_NAME: str = "session_id"
_STREAM_REFS_VAR_NAME: str = "stream_refs"

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
    audio_stream_var_name : str | None
        The key inside ``stream_refs`` that names the audio_stream Start variable,
        or ``None`` if the script does not use live audio streaming.
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


def inspect_script(script_source: str) -> ScriptMetadata:
    """Parse script_source and extract all metadata without executing it.

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
        import re
        # Look for "stream_refs": json.dumps({"Input": stream_id})
        m = re.search(r'["\']stream_refs["\']\s*:\s*json\.dumps\(\{\s*["\']([^"\']+)["\']', script_source)
        if m:
            extractor.audio_stream_var_name = m.group(1)

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
        file_var_names=list(dict.fromkeys(extractor.file_var_names)),
        audio_stream_var_name=extractor.audio_stream_var_name,
        has_audio_output=extractor.has_audio_output,
        has_audio_file_output=extractor.has_audio_file_output,
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
        assert isinstance(query, str) and query, "query must be a non-empty string"
        self.query = query
        self.session_id = session_id
        self.files: dict[str, str] = files or {}
        self.meta = meta
        self.replaced_query = False
        self.bypassed_session = False

    def visit_Assign(self, node: ast.Assign) -> ast.AST:  # noqa: N802
        """Rewrite inputs, session_id, and session creation assignments."""
        if len(node.targets) != 1 or not isinstance(node.targets[0], ast.Name):
            return self.generic_visit(node)

        name = node.targets[0].id
        value = node.value

        if name == "inputs" and isinstance(value, ast.Dict):
            self._inject_query_into_dict(value)
            return node

        if name == _SESSION_VAR_NAME and self.session_id and not self.bypassed_session:
            self.bypassed_session = True
            node.value = ast.Constant(value=self.session_id)
            return node

        return self.generic_visit(node)

    def _inject_query_into_dict(self, dict_node: ast.Dict) -> None:
        """Mutate dict_node to replace the query placeholder with self.query.

        Parameters
        ----------
        dict_node : ast.Dict
            The inputs dict literal to mutate in-place.
        """
        assert isinstance(dict_node, ast.Dict), "Expected ast.Dict"
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

    def visit_Call(self, node: ast.Call) -> ast.AST:  # noqa: N802
        """Rewrite open("placeholder.ext", ...) calls for known file vars."""
        if (
            isinstance(node.func, ast.Name)
            and node.func.id == "open"
            and len(node.args) >= 1
            and isinstance(node.args[0], ast.Constant)
            and self.files
        ):
            first_path = next(iter(self.files.values()))
            node.args[0] = ast.Constant(value=first_path)
        return self.generic_visit(node)


def rewrite_script(
    script_source: str,
    query: str,
    session_id: Optional[str] = None,
    files: Optional[dict[str, str]] = None,
) -> str:
    """Inject runtime values into script_source and return the modified source.

    Parameters
    ----------
    script_source : str
        Full source text of script.py.
    query : str
        User's text input to inject into the ``inputs`` dict.
    session_id : str | None
        If provided, replaces the session_id assignment to reuse an existing
        platform session instead of creating a new one.
    files : dict[str, str] | None
        Maps file variable names to temporary local paths on disk.

    Returns
    -------
    str
        Modified Python source ready to be written to a temp file and executed.

    Raises
    ------
    SyntaxError
        If script_source is not valid Python.
    ValueError
        If the script is missing required Paradigm Platform constants.
    """
    assert isinstance(script_source, str) and script_source, \
        "script_source must be non-empty"
    assert isinstance(query, str) and query, "query must be non-empty"

    meta = inspect_script(script_source)

    tree = ast.parse(script_source)
    rewriter = _ScriptRewriter(query=query, session_id=session_id, files=files, meta=meta)
    new_tree = rewriter.visit(tree)
    ast.fix_missing_locations(new_tree)

    new_source: str = ast.unparse(new_tree)

    # String-replace fallback for rare cases where inputs dict is not a static literal
    if not rewriter.replaced_query and '"<value>"' in new_source:
        new_source = new_source.replace('"<value>"', json.dumps(query))
        logger.warning(
            "rewrite_script: fell back to string-replace for query injection — "
            "inputs dict may not be a static literal."
        )

    return new_source
