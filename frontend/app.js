/**
 * Chat application logic — sends queries to the backend which runs
 * script.py, and streams the response into the chat UI.
 */

/* ── Constants ────────────────────────────────────────────────────────── */
const API_BASE = window.location.origin;
const ENDPOINTS = Object.freeze({
  CHAT_STREAM: `${API_BASE}/api/chat/stream`,
  HEALTH:      `${API_BASE}/api/health-check`,
});

const AUTO_SCROLL_THRESHOLD_PX = 120;


/* ── State ────────────────────────────────────────────────────────────── */
let isStreaming     = false;
let abortController = null;
let attachedFile    = null;


/* ── DOM refs ─────────────────────────────────────────────────────────── */
const chatArea      = document.getElementById("chat-area");
const messagesEl    = document.getElementById("messages");
const welcomeScreen = document.getElementById("welcome-screen");
const queryInput    = document.getElementById("query-input");
const btnSend       = document.getElementById("btn-send");
const btnAttach     = document.getElementById("btn-attach");
const btnNewChat    = document.getElementById("btn-new-chat");
const fileInput     = document.getElementById("file-input");
const fileChip      = document.getElementById("file-chip");
const fileNameEl    = document.getElementById("file-name");
const removeFileBtn = document.getElementById("remove-file");


/* ── Markdown Rendering ───────────────────────────────────────────────── */

/**
 * Convert a raw text string into minimal HTML with markdown-like formatting.
 *
 * Handles: code blocks, inline code, bold, italic, links, and line breaks.
 *
 * @param {string} text - Raw text to format.
 * @returns {string} HTML string.
 */
function renderMarkdown(text) {
  if (!text) return "";

  let html = text;

  // Escape HTML entities first
  html = html.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Code blocks (``` ... ```)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre><code class="lang-${lang}">${code.trim()}</code></pre>`;
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

  // Italic
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // Unordered lists
  html = html.replace(/^[*-] (.+)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (match) => `<ul>${match}</ul>`);

  // Ordered lists
  html = html.replace(/^\d+\.\s(.+)$/gm, "<li>$1</li>");

  // Line breaks → paragraphs (double newline) or <br> (single)
  html = html.replace(/\n\n/g, "</p><p>");
  html = html.replace(/\n/g, "<br>");

  // Wrap in paragraph if not already block-level
  if (!html.startsWith("<pre") && !html.startsWith("<ul") && !html.startsWith("<ol")) {
    html = `<p>${html}</p>`;
  }

  return html;
}


/* ── Message Rendering ────────────────────────────────────────────────── */

/**
 * Append a user message bubble to the chat.
 *
 * @param {string} text - The user's message text.
 */
function appendUserMessage(text) {
  welcomeScreen.style.display = "none";
  messagesEl.style.display = "flex";

  const msgEl = document.createElement("div");
  msgEl.className = "message user";
  msgEl.innerHTML = `
    <div class="message-avatar">👤</div>
    <div class="message-content"><p>${escapeHtml(text)}</p></div>
  `;
  messagesEl.appendChild(msgEl);
  scrollToBottom();
}

/**
 * Create an empty assistant message bubble and return handles for streaming.
 *
 * @returns {{ container: HTMLElement, contentEl: HTMLElement }}
 */
function createAssistantMessage() {
  const msgEl = document.createElement("div");
  msgEl.className = "message assistant";

  const contentEl = document.createElement("div");
  contentEl.className = "message-content";
  contentEl.innerHTML = `<div class="thinking-dots"><span></span><span></span><span></span></div>`;

  msgEl.innerHTML = `<div class="message-avatar">🤖</div>`;
  msgEl.appendChild(contentEl);
  messagesEl.appendChild(msgEl);
  scrollToBottom();

  return { container: msgEl, contentEl };
}

/**
 * Append an error message to the chat with an optional retry button.
 *
 * @param {string} detail - Error description.
 * @param {string | null} query - The query to retry, or null to omit retry.
 */
function appendErrorMessage(detail, query) {
  const el = document.createElement("div");
  el.className = "message-error";
  el.innerHTML = `⚠️ ${escapeHtml(detail)}`;

  if (query) {
    const retryBtn = document.createElement("button");
    retryBtn.className = "retry-btn";
    retryBtn.textContent = "Retry";
    retryBtn.addEventListener("click", () => {
      el.remove();
      sendMessage(query);
    });
    el.appendChild(retryBtn);
  }

  messagesEl.appendChild(el);
  scrollToBottom();
}

/**
 * Escape HTML entities in a string.
 *
 * @param {string} str - Raw string.
 * @returns {string} Escaped string safe for innerHTML.
 */
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}


/* ── Streaming ────────────────────────────────────────────────────────── */

/**
 * Send a query to the backend (which runs script.py) and stream the response.
 *
 * @param {string} query - The user's message.
 */
async function sendMessage(query) {
  if (isStreaming || !query.trim()) return;

  isStreaming = true;
  updateSendButton();

  appendUserMessage(query.trim());
  const { contentEl } = createAssistantMessage();

  let tokenBuffer      = "";
  let hasReceivedToken  = false;

  try {
    abortController = new AbortController();

    const form = new FormData();
    form.append("query", query.trim());

    if (attachedFile) {
      form.append("file", attachedFile);
      clearFile();
    }

    const response = await fetch(ENDPOINTS.CHAT_STREAM, {
      method: "POST",
      body: form,
      signal: abortController.signal,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Request failed (${response.status}): ${errText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep incomplete last line

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed === "data: [DONE]") continue;
        if (!trimmed.startsWith("data:")) continue;

        let event;
        try {
          event = JSON.parse(trimmed.slice(5).trim());
        } catch {
          continue;
        }

        const evType = event.event;

        if (evType === "token") {
          if (!hasReceivedToken) {
            hasReceivedToken = true;
            contentEl.innerHTML = "";
          }
          tokenBuffer += event.token;
          contentEl.innerHTML = renderMarkdown(tokenBuffer) + '<span class="streaming-cursor"></span>';
          scrollToBottom();
        } else if (evType === "complete") {
          // Render final output cleanly
          const finalText = event.final_output?.output || tokenBuffer;
          contentEl.innerHTML = renderMarkdown(finalText);
          scrollToBottom();
        } else if (evType === "error") {
          throw new Error(event.detail || "Unknown workflow error");
        }
      }
    }

    // If no complete event arrived but we have tokens, finalize
    if (tokenBuffer && contentEl.querySelector(".streaming-cursor")) {
      contentEl.innerHTML = renderMarkdown(tokenBuffer);
    }

  } catch (err) {
    if (err.name === "AbortError") {
      if (tokenBuffer) {
        contentEl.innerHTML = renderMarkdown(tokenBuffer);
      } else {
        contentEl.innerHTML = "<p><em>Cancelled.</em></p>";
      }
    } else {
      contentEl.innerHTML = "";
      appendErrorMessage(err.message, query.trim());
    }
  } finally {
    isStreaming = false;
    abortController = null;
    updateSendButton();
    scrollToBottom();
  }
}


/* ── UI Helpers ───────────────────────────────────────────────────────── */

/** Scroll the chat area to the bottom if the user is near the bottom. */
function scrollToBottom() {
  const { scrollTop, scrollHeight, clientHeight } = chatArea;
  const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
  if (distanceFromBottom < AUTO_SCROLL_THRESHOLD_PX || isStreaming) {
    chatArea.scrollTop = scrollHeight;
  }
}

/** Update the send button appearance based on streaming state. */
function updateSendButton() {
  if (isStreaming) {
    btnSend.innerHTML = "■";
    btnSend.classList.add("streaming");
    btnSend.disabled = false;
    btnSend.title = "Stop";
  } else {
    btnSend.innerHTML = "▶";
    btnSend.classList.remove("streaming");
    btnSend.disabled = false;
    btnSend.title = "Send";
  }
}

/** Auto-resize the textarea to fit content. */
function autoResizeTextarea() {
  queryInput.style.height = "auto";
  queryInput.style.height = Math.min(queryInput.scrollHeight, 150) + "px";
}

/** Clear the attached file. */
function clearFile() {
  attachedFile = null;
  fileInput.value = "";
  fileChip.classList.remove("visible");
  btnAttach.classList.remove("has-file");
}

/** Reset the chat to a fresh state. */
function resetChat() {
  isStreaming = false;
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
  messagesEl.innerHTML = "";
  messagesEl.style.display = "none";
  welcomeScreen.style.display = "flex";
  clearFile();
  queryInput.value = "";
  autoResizeTextarea();
  queryInput.focus();
  updateSendButton();
}


/* ── Event Handlers ───────────────────────────────────────────────────── */

/** Handle send button click or Enter key. */
function handleSend() {
  if (isStreaming) {
    if (abortController) abortController.abort();
    return;
  }

  const query = queryInput.value.trim();
  if (!query) return;

  queryInput.value = "";
  autoResizeTextarea();
  sendMessage(query);
}

// Send button
btnSend.addEventListener("click", handleSend);

// Keyboard: Enter sends, Shift+Enter inserts newline
queryInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
});

// Auto-resize on input
queryInput.addEventListener("input", autoResizeTextarea);

// New chat
btnNewChat.addEventListener("click", resetChat);

// File attachment
btnAttach.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (file) {
    attachedFile = file;
    fileNameEl.textContent = file.name;
    fileChip.classList.add("visible");
    btnAttach.classList.add("has-file");
  }
});

removeFileBtn.addEventListener("click", clearFile);

// Quick prompts
document.querySelectorAll(".quick-prompt").forEach((btn) => {
  btn.addEventListener("click", () => {
    const prompt = btn.getAttribute("data-prompt");
    if (prompt) {
      queryInput.value = prompt;
      handleSend();
    }
  });
});


/* ── Init ─────────────────────────────────────────────────────────────── */
queryInput.focus();
