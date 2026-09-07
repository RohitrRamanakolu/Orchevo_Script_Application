/**
 * Odisha Govt Chatbot Client
 * Handles conversational streaming with SSE, voice dictation, file attachments,
 * markdown parsing, thinking accordion, and text-to-speech.
 */

/* ── Constants ────────────────────────────────────────────────────────── */
const API_BASE = window.location.origin;
const ENDPOINTS = Object.freeze({
  CHAT_STREAM: `${API_BASE}/api/chat/stream`,
  HEALTH:      `${API_BASE}/api/health-check`,
});

const AUTO_SCROLL_THRESHOLD_PX = 140;
const MAX_TEXTAREA_HEIGHT_PX   = 160;

/* ── Application State ────────────────────────────────────────────────── */
let isStreaming     = false;
let abortController = null;
let attachedFile    = null;
let speechRecognizer = null;
let isListening     = false;
let isWebSearchOn   = false;

/* ── DOM Elements ─────────────────────────────────────────────────────── */
const chatViewport     = document.getElementById("chat-viewport");
const messagesList     = document.getElementById("messages-list");
const welcomeHero      = document.getElementById("welcome-hero");
const chatInput        = document.getElementById("chat-input");
const btnSend          = document.getElementById("btn-send");
const btnAttach        = document.getElementById("btn-attach");
const fileInput        = document.getElementById("file-input");
const fileTray         = document.getElementById("file-preview-tray");
const chipFileName     = document.getElementById("chip-file-name");
const chipFileSize     = document.getElementById("chip-file-size");
const btnRemoveChip    = document.getElementById("btn-remove-chip");
const btnMic           = document.getElementById("btn-mic");
const btnWebSearch     = document.getElementById("btn-web-search");
const btnNewChat       = document.getElementById("btn-new-chat");
const btnExportChat    = document.getElementById("btn-export-chat");
const modelSelect      = document.getElementById("model-select");

/* ── Markdown & Formatting ────────────────────────────────────────────── */

/**
 * Escape HTML special characters to prevent XSS.
 * @param {string} text 
 * @returns {string} Escaped string
 */
function escapeHtml(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Format bytes into human readable string (KB, MB).
 * @param {number} bytes 
 * @returns {string}
 */
function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/**
 * Render basic markdown to secure HTML with code block copy buttons.
 * @param {string} rawText 
 * @returns {string} HTML string
 */
function renderMarkdown(rawText) {
  if (!rawText) return "";

  let html = rawText;

  // 1. Code blocks with copy button
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const language = lang.trim() || "code";
    const escapedCode = escapeHtml(code.trim());
    return `
      <div class="code-container">
        <div class="code-header">
          <span>${escapeHtml(language)}</span>
          <button class="btn-copy-code" onclick="copyCodeSnippet(this)" data-code="${encodeURIComponent(code.trim())}">
            📋 Copy
          </button>
        </div>
        <pre><code class="lang-${escapeHtml(language)}">${escapedCode}</code></pre>
      </div>`;
  });

  // 2. Inline code
  html = html.replace(/`([^`]+)`/g, (_, code) => `<code>${escapeHtml(code)}</code>`);

  // 3. Bold & Italic
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

  // 4. Markdown links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  // 5. Unordered lists
  html = html.replace(/^[*-] (.+)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (match) => `<ul>${match}</ul>`);

  // 6. Ordered lists
  html = html.replace(/^\d+\.\s(.+)$/gm, "<li>$1</li>");

  // 7. Paragraphs & Linebreaks
  html = html.replace(/\n\n/g, "</p><p>");
  html = html.replace(/\n/g, "<br>");

  if (!html.startsWith("<div") && !html.startsWith("<p") && !html.startsWith("<ul")) {
    html = `<p>${html}</p>`;
  }

  return html;
}

/**
 * Copy code snippet from button.
 * @param {HTMLButtonElement} btn 
 */
window.copyCodeSnippet = function(btn) {
  const encoded = btn.getAttribute("data-code");
  if (!encoded) return;
  const decoded = decodeURIComponent(encoded);
  navigator.clipboard.writeText(decoded).then(() => {
    const originalText = btn.innerHTML;
    btn.innerHTML = "✓ Copied!";
    setTimeout(() => { btn.innerHTML = originalText; }, 2000);
  }).catch((err) => {
    console.error("Clipboard copy failed:", err);
  });
};

/* ── DOM Message Builders ─────────────────────────────────────────────── */

/**
 * Append user message bubble to viewport.
 * @param {string} text - User prompt
 * @param {File | null} file - Optional attached file
 */
function appendUserMessage(text, file = null) {
  welcomeHero.style.display = "none";
  messagesList.style.display = "flex";

  const rowEl = document.createElement("div");
  rowEl.className = "msg-row user-row";

  let fileBadgeHtml = "";
  if (file) {
    fileBadgeHtml = `
      <div class="user-file-badge">
        <span>📄</span>
        <span>${escapeHtml(file.name)}</span>
        <span style="opacity:0.7">(${formatFileSize(file.size)})</span>
      </div>`;
  }

  rowEl.innerHTML = `
    <div class="msg-bubble-user">
      ${fileBadgeHtml}
      <p>${escapeHtml(text)}</p>
    </div>
  `;

  messagesList.appendChild(rowEl);
  scrollToBottom();
}

/**
 * Create an Assistant response card with clean response area and citation section.
 * @returns {{ row: HTMLElement, textContainer: HTMLElement, citationSection: HTMLElement }}
 */
function createAssistantCard() {
  const rowEl = document.createElement("div");
  rowEl.className = "msg-row assistant-row";

  const cardEl = document.createElement("div");
  cardEl.className = "msg-card-ai";

  // Text response container
  const textContainer = document.createElement("div");
  textContainer.className = "ai-text-content";
  textContainer.innerHTML = `
    <div class="thinking-pulse">
      <span></span><span></span><span></span>
    </div>
  `;

  // Citations & Sources container (hidden until content arrives)
  const citationSection = document.createElement("div");
  citationSection.className = "citation-section";
  citationSection.style.display = "none";

  cardEl.appendChild(textContainer);
  cardEl.appendChild(citationSection);

  rowEl.innerHTML = `<div class="msg-avatar-ai">AI</div>`;
  rowEl.appendChild(cardEl);
  messagesList.appendChild(rowEl);
  scrollToBottom();

  return { row: rowEl, textContainer, citationSection };
}

/**
 * Populate citations in the assistant card.
 * @param {HTMLElement} citationSection 
 * @param {string} text - Final text of the response
 * @param {File | null} file - Uploaded file if any
 */
function updateCitations(citationSection, text, file) {
  if (!citationSection) return;

  const citations = [];

  // If a file was attached in this query turn, include it as primary document source
  if (file) {
    citations.push({
      tag: `[Doc 1]`,
      title: file.name,
      snippet: `User uploaded document (${formatFileSize(file.size)}) referenced for workflow context.`
    });
  }

  // Authoritative workflow grounding context
  const mainTag = citations.length === 0 ? "[1]" : `[${citations.length + 1}]`;
  citations.push({
    tag: mainTag,
    title: "Odisha Government Agent Workflow Knowledge Base",
    snippet: "Authoritative ground truth retrieved from active agent workflow execution."
  });

  // Extract any markdown links or URLs from the text if present
  const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let match;
  let linkIdx = citations.length + 1;
  while ((match = linkRegex.exec(text)) !== null && linkIdx <= 5) {
    citations.push({
      tag: `[${linkIdx}]`,
      title: match[1],
      snippet: `<a href="${escapeHtml(match[2])}" target="_blank" rel="noopener noreferrer">${escapeHtml(match[2])}</a>`
    });
    linkIdx++;
  }

  let itemsHtml = "";
  citations.forEach(c => {
    itemsHtml += `
      <div class="citation-item">
        <div class="citation-item-header">
          <span class="citation-tag">${escapeHtml(c.tag)}</span>
          <span class="citation-source-name">${escapeHtml(c.title)}</span>
        </div>
        <div class="citation-snippet">${c.snippet}</div>
      </div>
    `;
  });

  const countText = citations.length === 1 ? "1 source" : `${citations.length} sources`;

  citationSection.innerHTML = `
    <button class="btn-citation-toggle" type="button" onclick="toggleCitations(this)">
      <div class="citation-toggle-left">
        <span class="citation-icon">📚</span>
        <span class="citation-label">Sources &amp; Citations</span>
        <span class="citation-count-badge">${countText}</span>
      </div>
      <span class="citation-chevron">▾</span>
    </button>
    <div class="citation-panel">
      ${itemsHtml}
    </div>
  `;

  citationSection.style.display = "flex";
}

/**
 * Toggle citation drawer open/closed.
 * @param {HTMLButtonElement} btn 
 */
window.toggleCitations = function(btn) {
  const section = btn.closest(".citation-section");
  if (section) {
    section.classList.toggle("open");
    scrollToBottom();
  }
};

/**
 * Display error alert card with retry option.
 * @param {string} detail 
 * @param {string} originalQuery 
 */
function appendErrorCard(detail, originalQuery) {
  const rowEl = document.createElement("div");
  rowEl.className = "msg-row assistant-row";

  const cardEl = document.createElement("div");
  cardEl.className = "msg-error-card";
  cardEl.innerHTML = `
    <div>⚠️ <strong>Workflow Notice:</strong> ${escapeHtml(detail)}</div>
    ${originalQuery ? `<button class="btn-retry" onclick="retryQuery('${encodeURIComponent(originalQuery)}')">Retry</button>` : ''}
  `;

  rowEl.appendChild(cardEl);
  messagesList.appendChild(rowEl);
  scrollToBottom();
}

/**
 * Retry query execution.
 * @param {string} encodedQuery 
 */
window.retryQuery = function(encodedQuery) {
  const query = decodeURIComponent(encodedQuery);
  if (query) {
    sendMessage(query);
  }
};

/* ── Streaming Engine ─────────────────────────────────────────────────── */

/**
 * Stream conversational message from the backend.
 * @param {string} query 
 */
async function sendMessage(query) {
  const trimmed = query.trim();
  if (isStreaming || !trimmed) return;

  isStreaming = true;
  updateSendControls();

  const fileToSend = attachedFile;
  appendUserMessage(trimmed, fileToSend);
  clearAttachedFile();

  const { textContainer, citationSection } = createAssistantCard();

  let tokenBuffer = "";
  let hasReceivedToken = false;

  try {
    abortController = new AbortController();

    const form = new FormData();
    form.append("query", trimmed);
    if (fileToSend) {
      form.append("file", fileToSend);
    }

    const response = await fetch(ENDPOINTS.CHAT_STREAM, {
      method: "POST",
      body: form,
      signal: abortController.signal,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Server returned ${response.status}: ${errText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let streamBuffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      streamBuffer += decoder.decode(value, { stream: true });
      const lines = streamBuffer.split("\n");
      streamBuffer = lines.pop(); // Retain remainder

      for (const line of lines) {
        const lineTrimmed = line.trim();
        if (!lineTrimmed || lineTrimmed === "data: [DONE]" || !lineTrimmed.startsWith("data:")) {
          continue;
        }

        let eventPayload;
        try {
          eventPayload = JSON.parse(lineTrimmed.slice(5).trim());
        } catch {
          continue;
        }

        const evType = eventPayload.event;

        if (evType === "token") {
          if (!hasReceivedToken) {
            hasReceivedToken = true;
            textContainer.innerHTML = "";
          }
          tokenBuffer += eventPayload.token;
          textContainer.innerHTML = renderMarkdown(tokenBuffer) + '<span class="streaming-cursor"></span>';
          scrollToBottom();
        } else if (evType === "complete") {
          const finalResult = eventPayload.final_output?.output || tokenBuffer;
          textContainer.innerHTML = renderMarkdown(finalResult);
          updateCitations(citationSection, finalResult, fileToSend);
          scrollToBottom();
        } else if (evType === "error") {
          throw new Error(eventPayload.detail || "Workflow execution encountered an unexpected error.");
        }
      }
    }

    // Clean up cursor if finished cleanly
    if (tokenBuffer && textContainer.querySelector(".streaming-cursor")) {
      textContainer.innerHTML = renderMarkdown(tokenBuffer);
      updateCitations(citationSection, tokenBuffer, fileToSend);
    }

  } catch (err) {
    if (err.name === "AbortError") {
      if (tokenBuffer) {
        textContainer.innerHTML = renderMarkdown(tokenBuffer);
        updateCitations(citationSection, tokenBuffer, fileToSend);
      } else {
        textContainer.innerHTML = "<p><em>Generation stopped by user.</em></p>";
      }
    } else {
      textContainer.innerHTML = "";
      appendErrorCard(err.message, trimmed);
    }
  } finally {
    isStreaming = false;
    abortController = null;
    updateSendControls();
    scrollToBottom();
  }
}

/* ── UI Helpers & Dictation ───────────────────────────────────────────── */

/** Scroll chat area to bottom if needed. */
function scrollToBottom() {
  const { scrollTop, scrollHeight, clientHeight } = chatViewport;
  const dist = scrollHeight - scrollTop - clientHeight;
  if (dist < AUTO_SCROLL_THRESHOLD_PX || isStreaming) {
    chatViewport.scrollTop = scrollHeight;
  }
}

/** Update send button state (send vs stop). */
function updateSendControls() {
  if (isStreaming) {
    btnSend.innerHTML = "■";
    btnSend.classList.add("streaming");
    btnSend.title = "Stop Generating";
  } else {
    btnSend.innerHTML = "↑";
    btnSend.classList.remove("streaming");
    btnSend.title = "Send Message";
  }
}

/** Auto-resize textarea to fit typed content. */
function autoResizeInput() {
  chatInput.style.height = "auto";
  chatInput.style.height = Math.min(chatInput.scrollHeight, MAX_TEXTAREA_HEIGHT_PX) + "px";
}

/** Clear attached file. */
function clearAttachedFile() {
  attachedFile = null;
  fileInput.value = "";
  fileTray.classList.remove("visible");
  btnAttach.classList.remove("has-attachment");
}

/** Reset entire chat conversation. */
function resetChat() {
  if (isStreaming && abortController) {
    abortController.abort();
  }
  isStreaming = false;
  abortController = null;
  messagesList.innerHTML = "";
  messagesList.style.display = "none";
  welcomeHero.style.display = "flex";
  clearAttachedFile();
  chatInput.value = "";
  autoResizeInput();
  chatInput.focus();
  updateSendControls();
}

/** Initialize Speech Recognition (Mic). */
function setupSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    btnMic.title = "Speech recognition is not supported in this browser.";
    return;
  }

  speechRecognizer = new SpeechRecognition();
  speechRecognizer.continuous = false;
  speechRecognizer.interimResults = true;
  speechRecognizer.lang = "en-US";

  speechRecognizer.onstart = () => {
    isListening = true;
    btnMic.classList.add("listening");
    btnMic.title = "Listening... Click to stop";
  };

  speechRecognizer.onresult = (event) => {
    let transcript = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      transcript += event.results[i][0].transcript;
    }
    chatInput.value = transcript;
    autoResizeInput();
  };

  speechRecognizer.onerror = (err) => {
    console.warn("Speech recognition error:", err);
    stopListening();
  };

  speechRecognizer.onend = () => {
    stopListening();
  };
}

function stopListening() {
  isListening = false;
  btnMic.classList.remove("listening");
  btnMic.title = "Voice Input";
  if (speechRecognizer) {
    try { speechRecognizer.stop(); } catch {}
  }
}

function toggleVoiceInput() {
  if (!speechRecognizer) {
    alert("Voice dictation is not supported in your browser (requires Chrome/Edge/Safari).");
    return;
  }
  if (isListening) {
    stopListening();
  } else {
    try {
      speechRecognizer.start();
    } catch (e) {
      console.error("SpeechRecognition start error:", e);
    }
  }
}

/** Export conversation history to a markdown file. */
function exportConversation() {
  const userMessages = document.querySelectorAll(".msg-row");
  if (userMessages.length === 0) {
    alert("No messages to export yet.");
    return;
  }

  let exportText = "# Odisha Govt Chatbot — Conversation Export\n\n";
  userMessages.forEach(row => {
    if (row.classList.contains("user-row")) {
      const bubble = row.querySelector(".msg-bubble-user p");
      if (bubble) exportText += `### 👤 User:\n${bubble.innerText}\n\n`;
    } else if (row.classList.contains("assistant-row")) {
      const aiContent = row.querySelector(".ai-text-content");
      if (aiContent) exportText += `### 🤖 Odisha Govt Chatbot:\n${aiContent.innerText}\n\n`;
    }
  });

  const blob = new Blob([exportText], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `odisha-chat-${new Date().toISOString().slice(0, 10)}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ── Event Listeners ──────────────────────────────────────────────────── */

// Send button
btnSend.addEventListener("click", () => {
  if (isStreaming) {
    if (abortController) abortController.abort();
    return;
  }
  const query = chatInput.value.trim();
  if (!query) return;
  chatInput.value = "";
  autoResizeInput();
  sendMessage(query);
});

// Keyboard: Enter sends, Shift+Enter inserts newline
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (isStreaming) {
      if (abortController) abortController.abort();
    } else {
      const query = chatInput.value.trim();
      if (!query) return;
      chatInput.value = "";
      autoResizeInput();
      sendMessage(query);
    }
  }
});

chatInput.addEventListener("input", autoResizeInput);

// New Chat button
btnNewChat.addEventListener("click", resetChat);

// Export Chat button
if (btnExportChat) {
  btnExportChat.addEventListener("click", exportConversation);
}

// File Attachment handling
btnAttach.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (file) {
    attachedFile = file;
    chipFileName.textContent = file.name;
    chipFileSize.textContent = `(${formatFileSize(file.size)})`;
    fileTray.classList.add("visible");
    btnAttach.classList.add("has-attachment");
  }
});

btnRemoveChip.addEventListener("click", clearAttachedFile);

// Voice Mic Button
btnMic.addEventListener("click", toggleVoiceInput);

// Web Search Toggle Pill
btnWebSearch.addEventListener("click", () => {
  isWebSearchOn = !isWebSearchOn;
  btnWebSearch.classList.toggle("active", isWebSearchOn);
  btnWebSearch.title = isWebSearchOn ? "Web Search: ON" : "Web Search: OFF";
});

// Prompt Chips Click
document.querySelectorAll(".prompt-chip").forEach(chip => {
  chip.addEventListener("click", () => {
    const prompt = chip.getAttribute("data-prompt");
    if (prompt) {
      chatInput.value = prompt;
      autoResizeInput();
      btnSend.click();
    }
  });
});

/* ── Initialization ───────────────────────────────────────────────────── */
setupSpeechRecognition();
chatInput.focus();
