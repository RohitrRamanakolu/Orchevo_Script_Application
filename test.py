import requests, json

WORKFLOW_KEY = "N9tuOyfTKPzLWA4IjIyz19jpONPbTK59I8xMNnQsZVE"
WORKFLOW_ID  = "29fcf42e-56a6-4cd8-a634-062beabe3067"
BASE_URL     = "https://map-qa.paradigmit.ai/api/v1/agent-workflows"  # change if calling a different environment

# ── Step 1: Create a session (once per conversation) ──────────────────────
# Each session accumulates execution history across multiple calls.
# Re-use the same session_id for follow-up turns in the same conversation.
session_resp = requests.post(
    f"{BASE_URL}/sessions",
    json={"workflow_id": WORKFLOW_ID, "name": "My session"},
    headers={"X-Workflow-Key": WORKFLOW_KEY},
)
session_resp.raise_for_status()
session_id = session_resp.json()["session_id"]

# ── Step 2: Execute ───────────────────────────────────────────────────────
inputs = {"query": "<value>"}
resp = requests.post(
    f"{BASE_URL}/execute/stream",
    data={
        "inputs": json.dumps(inputs),
        "workflow_id": WORKFLOW_ID,
        "session_id": session_id,
    },
    headers={"X-Workflow-Key": WORKFLOW_KEY},
    stream=True,
)

# Optional: attach a file for variable 'file'
# with open("your_file.pdf", "rb") as file_f:
#     resp = requests.post(
#         f"{BASE_URL}/execute/stream",
#         data={
#             "inputs": json.dumps(inputs),
#             "workflow_id": WORKFLOW_ID,
#             "session_id": session_id,
#         },
#         files={"file": file_f},
#         headers={"X-Workflow-Key": WORKFLOW_KEY},
#         stream=True,
#     )
resp.raise_for_status()

# ── Step 3: Read the SSE stream ────────────────────────────────────────────
# Events in order:
#   session      — carries session_id + execution_id (always first)
#   token        — one per generated token (streaming model nodes only)
#   node_complete — after each node finishes: execution_ms, input, output,
#                   token_usage, cost_usd, logs, status, error, session_id, execution_id
#   complete     — final_output, node_traces, all_outputs, cost_usd, execution_path,
#                   session_id, execution_id, total_execution_ms
#   error        — on failure, carries detail + session_id
result = None
execution_id = None
for raw_line in resp.iter_lines():
    if not raw_line:
        continue
    line = raw_line.decode() if isinstance(raw_line, bytes) else raw_line
    if line == "data: [DONE]":
        break
    if not line.startswith("data:"):
        continue
    event = json.loads(line[len("data:"):].strip())
    ev = event.get("event")
    if ev == "session":
        execution_id = event.get("execution_id")
    elif ev == "token":
        print(event["token"], end="", flush=True)
    elif ev == "complete":
        result = event
    elif ev == "error":
        raise RuntimeError(f"Workflow error: {event.get('detail')}")
print()

if result is None:
    raise RuntimeError("Stream ended without a complete event")

# ── Step 4: Read output ────────────────────────────────────────────────────
# Output structure:
# {
#     "output": "...",
# }
final_output = result["final_output"]
output = final_output["output"]

# ── Optional: retrieve full session history ─────────────────────────────────
# session_detail = requests.get(
#     f"{BASE_URL}/sessions/{session_id}",
#     headers={"X-Workflow-Key": WORKFLOW_KEY},
# ).json()