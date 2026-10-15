"""Client for the published QA workflow "odisha wss voice and chat tool".

Ask by text or by voice; every answer comes back as text (`output`) AND speech
(`audio_file_output`, saved to answer.wav). Reuse one session per conversation.

Usage:
    python3 odisha_wss_voice_chat_tool_client.py "How many tribes live in Odisha?"
    python3 odisha_wss_voice_chat_tool_client.py --audio question.wav
"""
import argparse, base64, json
import requests

WORKFLOW_KEY = "BYIQFAXa29p0w3ehUYwRWNyUKpRJK3kLrCjA8uNky70"
WORKFLOW_ID  = "3d5b85c2-a298-4183-b338-ede3c30e9168"
BASE_URL     = "https://map-qa.paradigmit.ai/api/v1/agent-workflows"
HEADERS      = {"X-Workflow-Key": WORKFLOW_KEY}

def create_session() -> str:
    r = requests.post(f"{BASE_URL}/sessions", json={"workflow_id": WORKFLOW_ID, "name": "odisha chat"},
                      headers=HEADERS, timeout=60)
    r.raise_for_status()
    return r.json()["session_id"]

def ask(session_id, question=None, audio_path=None) -> dict:
    data = {"inputs": json.dumps({"query": question} if question else {}),
            "workflow_id": WORKFLOW_ID, "session_id": session_id}
    files = {"audio_input_stream": (audio_path, open(audio_path, "rb"), "audio/wav")} if audio_path else None
    r = requests.post(f"{BASE_URL}/execute/stream", data=data, files=files, headers=HEADERS,
                      stream=True, timeout=900)
    r.raise_for_status()
    for raw in r.iter_lines():
        line = raw.decode() if isinstance(raw, bytes) else raw
        if not line.startswith("data:") or line == "data: [DONE]":
            continue
        event = json.loads(line[5:].strip())
        if event.get("event") == "error":
            raise RuntimeError(event.get("detail"))
        if event.get("event") == "complete":
            return event["final_output"]
    raise RuntimeError("Stream ended without a complete event")

if __name__ == "__main__":
    p = argparse.ArgumentParser(); p.add_argument("question", nargs="?"); p.add_argument("--audio")
    a = p.parse_args()
    out = ask(create_session(), question=a.question, audio_path=a.audio)
    print("Answer:", out["output"])
    if out.get("audio_file_output_b64"):
        open("answer.wav", "wb").write(base64.b64decode(out["audio_file_output_b64"]))
        print("Spoken answer saved to answer.wav")

 