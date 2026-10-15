"""Client for the published DEV workflow "odisha wss voice and chat flash" (runs gemini-4-argon).

Ask by text or by voice; every answer comes back as text (`output`) AND speech
(`audio_file_output`, saved to answer.wav). Reuse one session per conversation.

Usage:
    python3 odisha_wss_voice_chat_tool_client.py "How many tribes live in Odisha?"
    python3 odisha_wss_voice_chat_tool_client.py --audio question.wav

Note: re-publishing the workflow issues a NEW key and revokes this one.
"""
from __future__ import annotations

import argparse
import base64
import json

import requests

WORKFLOW_KEY = "1WvPNykBSoGxDuh1eLhC-TpVRKCacfnBPPQdCfhFhOE"
WORKFLOW_ID = "37cdac50-cde1-41bc-8e6d-ff22a8525f2c"
BASE_URL = "https://map-dev.paradigmit.ai/api/v1/agent-workflows"
HEADERS = {"X-Workflow-Key": WORKFLOW_KEY}
ANSWER_AUDIO_PATH = "answer.wav"
REQUEST_TIMEOUT_S = 900


def create_session() -> str:
    """Start a conversation; reuse the returned id for follow-up turns."""
    resp = requests.post(f"{BASE_URL}/sessions", json={"workflow_id": WORKFLOW_ID, "name": "odisha chat"},
                         headers=HEADERS, timeout=60)
    resp.raise_for_status()
    return resp.json()["session_id"]


def ask(session_id: str, question: str | None = None, audio_path: str | None = None) -> dict:
    """Send one turn (text `query`, or a wav on `audio_input_stream`) and return final_output."""
    assert question or audio_path, "give a text question or an audio file"
    data = {"inputs": json.dumps({"query": question} if question else {}),
            "workflow_id": WORKFLOW_ID, "session_id": session_id}
    files = None
    if audio_path:
        files = {"audio_input_stream": (audio_path, open(audio_path, "rb"), "audio/wav")}
    resp = requests.post(f"{BASE_URL}/execute/stream", data=data, files=files, headers=HEADERS,
                         stream=True, timeout=REQUEST_TIMEOUT_S)
    resp.raise_for_status()
    for raw in resp.iter_lines():
        line = raw.decode() if isinstance(raw, bytes) else raw
        if not line or not line.startswith("data:") or line == "data: [DONE]":
            continue
        event = json.loads(line[len("data:"):].strip())
        if event.get("event") == "error":
            raise RuntimeError(f"Workflow error: {event.get('detail')}")
        if event.get("event") == "complete":
            return event["final_output"]
    raise RuntimeError("Stream ended without a complete event")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("question", nargs="?", help="text question")
    parser.add_argument("--audio", help="path to a .wav question")
    args = parser.parse_args()

    session_id = create_session()
    final_output = ask(session_id, question=args.question, audio_path=args.audio)

    print("Answer:", final_output["output"])
    audio_b64 = final_output.get("audio_file_output_b64")
    if audio_b64:
        with open(ANSWER_AUDIO_PATH, "wb") as out:
            out.write(base64.b64decode(audio_b64))
        print(f"Spoken answer saved to {ANSWER_AUDIO_PATH}")


if __name__ == "__main__":
    main()

 