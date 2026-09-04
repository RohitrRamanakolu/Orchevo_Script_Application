import type { StreamEvent } from "../types";

const API_BASE = window.location.origin;

export const ENDPOINTS = Object.freeze({
  CHAT_STREAM: `${API_BASE}/api/chat/stream`,
  HEALTH: `${API_BASE}/api/health-check`,
});

export interface StreamCallbacks {
  onToken: (token: string) => void;
  onComplete: (finalText: string) => void;
}

/**
 * POST a query (and optional file) to the chat-stream endpoint and invoke
 * callbacks as newline-delimited SSE-style `data:` events arrive.
 */
export async function streamChat(
  query: string,
  file: File | null,
  signal: AbortSignal,
  { onToken, onComplete }: StreamCallbacks
): Promise<void> {
  const form = new FormData();
  form.append("query", query);
  if (file) form.append("file", file);

  const response = await fetch(ENDPOINTS.CHAT_STREAM, {
    method: "POST",
    body: form,
    signal,
  });

  if (!response.ok || !response.body) {
    const errText = await response.text();
    throw new Error(`Request failed (${response.status}): ${errText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let tokenBuffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed === "data: [DONE]") continue;
      if (!trimmed.startsWith("data:")) continue;

      let event: StreamEvent;
      try {
        event = JSON.parse(trimmed.slice(5).trim());
      } catch {
        continue;
      }

      if (event.event === "token" && event.token) {
        tokenBuffer += event.token;
        onToken(event.token);
      } else if (event.event === "complete") {
        onComplete(event.final_output?.output || tokenBuffer);
      } else if (event.event === "error") {
        throw new Error(event.detail || "Unknown workflow error");
      }
    }
  }
}
