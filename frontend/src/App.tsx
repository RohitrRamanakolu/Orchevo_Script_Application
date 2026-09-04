import { useEffect, useRef, useState } from "react";
import Box from "@mui/material/Box";

import Header from "./components/Header";
import WelcomeScreen from "./components/WelcomeScreen";
import MessageList from "./components/MessageList";
import ChatInput from "./components/ChatInput";
import FooterCredit from "./components/FooterCredit";
import { streamChat } from "./api/chat";
import type { ChatItem } from "./types";

const AUTO_SCROLL_THRESHOLD_PX = 120;

function makeId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function App() {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [attachedFile, setAttachedFile] = useState<File | null>(null);

  const chatAreaRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const isStreamingRef = useRef(false);

  useEffect(() => {
    isStreamingRef.current = isStreaming;
  }, [isStreaming]);

  const scrollToBottom = () => {
    const el = chatAreaRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < AUTO_SCROLL_THRESHOLD_PX || isStreamingRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  };

  const sendMessage = async (query: string) => {
    if (isStreamingRef.current || !query.trim()) return;

    const trimmed = query.trim();
    setIsStreaming(true);

    const userMsgId = makeId();
    const assistantMsgId = makeId();
    const fileToSend = attachedFile;
    if (fileToSend) setAttachedFile(null);

    setItems((prev) => [
      ...prev,
      { id: userMsgId, role: "user", content: trimmed },
      { id: assistantMsgId, role: "assistant", content: "", isStreaming: true },
    ]);
    requestAnimationFrame(scrollToBottom);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    let tokenBuffer = "";

    const updateAssistant = (patch: Partial<ChatItem>) => {
      setItems((prev) =>
        prev.map((it) => (it.id === assistantMsgId ? ({ ...it, ...patch } as ChatItem) : it))
      );
    };

    try {
      await streamChat(trimmed, fileToSend, controller.signal, {
        onToken: (token) => {
          tokenBuffer += token;
          updateAssistant({ content: tokenBuffer });
          scrollToBottom();
        },
        onComplete: (finalText) => {
          tokenBuffer = finalText;
          updateAssistant({ content: finalText, isStreaming: false });
          scrollToBottom();
        },
      });

      // If no complete event arrived but we have tokens, finalize.
      updateAssistant({ isStreaming: false });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        updateAssistant({
          content: tokenBuffer,
          isStreaming: false,
          isCancelled: !tokenBuffer,
        });
      } else {
        const message = err instanceof Error ? err.message : "Unknown error";
        setItems((prev) => [
          ...prev.filter((it) => it.id !== assistantMsgId),
          { id: makeId(), kind: "error", detail: message, retryQuery: trimmed },
        ]);
      }
    } finally {
      setIsStreaming(false);
      abortControllerRef.current = null;
      scrollToBottom();
    }
  };

  const handleSend = () => {
    if (isStreaming) {
      abortControllerRef.current?.abort();
      return;
    }
    const query = inputValue.trim();
    if (!query) return;
    setInputValue("");
    void sendMessage(query);
  };

  const handleStop = () => {
    abortControllerRef.current?.abort();
  };

  const handleQuickPrompt = (prompt: string) => {
    setInputValue(prompt);
    if (isStreaming) return;
    void sendMessage(prompt);
  };

  const handleRetry = (query: string) => {
    void sendMessage(query);
  };

  const handleNewChat = () => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setIsStreaming(false);
    setItems([]);
    setAttachedFile(null);
    setInputValue("");
  };

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100vh", maxWidth: 900, mx: "auto", bgcolor: "background.default" }}>
      <Header onNewChat={handleNewChat} />

      <Box
        ref={chatAreaRef}
        className="scroll-thin"
        sx={{ flex: 1, overflowY: "auto", px: 2, py: 2.5, scrollBehavior: "smooth" }}
      >
        {items.length === 0 ? (
          <WelcomeScreen onQuickPrompt={handleQuickPrompt} />
        ) : (
          <MessageList items={items} onRetry={handleRetry} />
        )}
      </Box>

      <ChatInput
        value={inputValue}
        onChange={setInputValue}
        onSend={handleSend}
        onStop={handleStop}
        isStreaming={isStreaming}
        attachedFile={attachedFile}
        onAttachFile={setAttachedFile}
        onRemoveFile={() => setAttachedFile(null)}
      />

      <FooterCredit />
    </Box>
  );
}
