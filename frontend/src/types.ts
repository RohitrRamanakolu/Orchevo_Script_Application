export type MessageRole = "user" | "assistant";

export interface ChatMessage {
  id: string;
  role: MessageRole;
  /** Raw text content, rendered as markdown. Empty while streaming has not yet produced a token. */
  content: string;
  /** True while an assistant message is still receiving tokens. */
  isStreaming?: boolean;
  /** Set when the message represents a cancelled generation. */
  isCancelled?: boolean;
}

export interface ErrorItem {
  id: string;
  kind: "error";
  detail: string;
  /** The original query text, so the UI can offer a retry. */
  retryQuery: string;
}

export type ChatItem = (ChatMessage & { kind?: undefined }) | ErrorItem;

export interface StreamEvent {
  event: "token" | "complete" | "error";
  token?: string;
  detail?: string;
  final_output?: { output?: string };
}
