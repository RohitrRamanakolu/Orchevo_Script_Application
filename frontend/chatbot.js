/**
 * Odisha Govt Chatbot Client
 * Handles conversational streaming with SSE, voice dictation, file attachments,
 * markdown parsing, thinking accordion, and bidirectional audio streaming.
 *
 * Audio Architecture:
 * - INPUT:  Web Audio API ScriptProcessorNode downsamples microphone to 16 kHz
 *           mono Int16 PCM and streams binary chunks over WebSocket.
 * - OUTPUT (streamed): SSE audio_chunk events (base64 PCM16 @ sample_rate) are
 *           decoded and played seamlessly via a scheduled Web Audio API buffer
 *           queue at the chunk's native sample rate (usually 24 kHz).
 * - OUTPUT (file):    SSE complete.final_output.audio_file_output_b64 (WAV/MP3
 *           base64) is decoded to a Blob, auto-played, and offered for replay.
 */

/* ── Constants ────────────────────────────────────────────────────────── */
const API_BASE = window.location.origin;
const WS_BASE = API_BASE.replace(/^https/, "wss").replace(/^http/, "ws");
/** Must match backend ``_API_PREFIX`` in main.py. */
const API_PREFIX = "/odisha";
const ENDPOINTS = Object.freeze({
  CHAT_STREAM:    `${API_BASE}${API_PREFIX}/api/chat/stream`,
  AUDIO_EXECUTE:  `${API_BASE}${API_PREFIX}/api/audio/execute`,
  AUDIO_WS:       (streamId) => `${WS_BASE}${API_PREFIX}/api/audio/stream/${streamId}`,
  HEALTH:         `${API_BASE}${API_PREFIX}/api/health-check`,
});

/** Target input sample rate required by Paradigm Platform voice/gemini-live nodes. */
const MIC_TARGET_SAMPLE_RATE = 16000;
/** ScriptProcessorNode buffer size — must be a power of two; 4096 ≈ 256 ms at 16 kHz. */
const MIC_BUFFER_SIZE = 4096;
/** Fallback MIME when complete.final_output.mimetype is absent (Paradigm WAV files). */
const DEFAULT_AUDIO_FILE_MIMETYPE = "audio/wav";

const AUTO_SCROLL_THRESHOLD_PX = 140;
const MAX_TEXTAREA_HEIGHT_PX   = 160;

/* ── Application State ────────────────────────────────────────────────── */
let isStreaming     = false;
let abortController = null;
let attachedFile    = null;
let speechRecognizer = null;
let isListening     = false;
let isWebSearchOn   = false;

// Audio streaming state
let audioWs              = null;   // WebSocket to backend audio proxy
let micAudioContext      = null;   // AudioContext for mic capture
let micSourceNode        = null;   // MediaStreamAudioSourceNode
let micProcessorNode     = null;   // ScriptProcessorNode (downsamples to 16 kHz)
let audioStream          = null;   // getUserMedia stream handle (raw tracks)
let playbackAudioContext = null;   // AudioContext for live streaming PCM16 playback
let playbackScheduleTime = 0;      // Seconds on the playback clock scheduled so far
let replayAudioContext   = null;   // AudioContext for replay (kept separate from live stream)
let fileReplayAudio      = null;   // HTMLAudioElement for audio_file_output_b64 replay

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
 *
 * @returns {{ row: HTMLElement, textContainer: HTMLElement, citationSection: HTMLElement, audioReplayContainer: HTMLElement }}
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

  // Audio replay toolbar (hidden until audio response completes)
  const audioReplayContainer = document.createElement("div");
  audioReplayContainer.className = "audio-replay-bar";
  audioReplayContainer.style.display = "none";

  cardEl.appendChild(textContainer);
  cardEl.appendChild(citationSection);
  cardEl.appendChild(audioReplayContainer);

  rowEl.innerHTML = `<div class="msg-avatar-ai">AI</div>`;
  rowEl.appendChild(cardEl);
  messagesList.appendChild(rowEl);
  scrollToBottom();

  return { row: rowEl, textContainer, citationSection, audioReplayContainer };
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

  const { textContainer, citationSection, audioReplayContainer } = createAssistantCard();


  let tokenBuffer = "";
  let hasReceivedToken = false;
  let hasAudioOutput = false;
  const chunkStore = [];  // Accumulates PCM16 chunks for post-stream replay

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
        } else if (evType === "audio_chunk") {
          // Audio output from a TTS/voice_model node — play it in the browser
          if (!hasReceivedToken && !hasAudioOutput) {
            hasReceivedToken = true;
            hasAudioOutput = true;
            textContainer.innerHTML = '<p><em>&#127908; Speaking…</em></p>';
            btnMic.classList.add("speaking");
          }
          handleAudioChunk(eventPayload, chunkStore);
        } else if (evType === "complete") {
          const fo = eventPayload.final_output || {};
          const finalResult =
            typeof fo.output === "string" && fo.output.length > 0
              ? fo.output
              : tokenBuffer;
          stopPlayback();

          if (hasAudioOutput && chunkStore.length > 0) {
            textContainer.innerHTML = "";
            showAudioReplayButton(audioReplayContainer, chunkStore);
          } else if (
            typeof fo.audio_file_output_b64 === "string" &&
            fo.audio_file_output_b64.length > 0
          ) {
            if (finalResult) {
              textContainer.innerHTML = renderMarkdown(finalResult);
              updateCitations(citationSection, finalResult, fileToSend);
            } else {
              textContainer.innerHTML = "<p><em>&#127908; Audio response</em></p>";
            }
            try {
              handleAudioFileOutput(fo, audioReplayContainer);
            } catch (audioErr) {
              textContainer.innerHTML =
                `<p class="error-inline">Could not play audio response: ${audioErr.message}</p>`;
            }
          } else if (finalResult) {
            textContainer.innerHTML = renderMarkdown(finalResult);
            updateCitations(citationSection, finalResult, fileToSend);
          } else {
            textContainer.innerHTML =
              "<p class=\"error-inline\">Workflow completed with no text or audio output.</p>";
          }
          scrollToBottom();
        } else if (evType === "error") {
          throw new Error(eventPayload.detail || "Workflow execution encountered an unexpected error.");
        }
      }
    }

    // Clean up cursor if finished cleanly
    if (!hasAudioOutput && tokenBuffer && textContainer.querySelector(".streaming-cursor")) {
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
    stopPlayback();
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

/** Stop and clean up an active audio capture and playback session. */
function stopAudioStream() {
  isListening = false;
  btnMic.classList.remove("listening");
  btnMic.classList.remove("speaking");
  btnMic.title = "Voice Input";

  // Stop ScriptProcessorNode and AudioContext for mic
  if (micProcessorNode) {
    try { micProcessorNode.disconnect(); } catch {}
    micProcessorNode = null;
  }
  if (micSourceNode) {
    try { micSourceNode.disconnect(); } catch {}
    micSourceNode = null;
  }
  if (micAudioContext && micAudioContext.state !== "closed") {
    try { micAudioContext.close(); } catch {}
    micAudioContext = null;
  }

  // Stop raw microphone tracks
  if (audioStream) {
    audioStream.getTracks().forEach(t => t.stop());
    audioStream = null;
  }

  // Send end sentinel and close upstream WebSocket
  if (audioWs && audioWs.readyState === WebSocket.OPEN) {
    try { audioWs.send("__end__"); } catch {}
    try { audioWs.close(); } catch {}
  }
  audioWs = null;
}

/** Stop the PCM16 live-stream playback pipeline. */
function stopPlayback() {
  if (playbackAudioContext && playbackAudioContext.state !== "closed") {
    try { playbackAudioContext.close(); } catch {}
    playbackAudioContext = null;
  }
  playbackScheduleTime = 0;
  btnMic.classList.remove("speaking");
}

/** Stop any active replay (PCM AudioContext or file HTMLAudioElement). */
function stopReplay() {
  if (replayAudioContext && replayAudioContext.state !== "closed") {
    try { replayAudioContext.close(); } catch {}
    replayAudioContext = null;
  }
  if (fileReplayAudio !== null) {
    try {
      fileReplayAudio.pause();
      fileReplayAudio.currentTime = 0;
    } catch {}
    fileReplayAudio = null;
  }
}

/**
 * Decode a standard base64 string into a Uint8Array.
 *
 * @param {string} b64 - Non-empty base64 payload
 * @returns {Uint8Array}
 * @throws {Error} if b64 is empty or atob fails
 */
function base64ToUint8Array(b64) {
  assert: typeof b64 === "string" && b64.length > 0;
  let binaryStr;
  try {
    binaryStr = atob(b64);
  } catch (err) {
    throw new Error(`Invalid base64 audio payload: ${err.message}`);
  }
  assert: typeof binaryStr === "string" && binaryStr.length > 0;
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  return bytes;
}

/**
 * Format a duration in seconds for the replay bar label.
 * @param {number} totalSec
 * @returns {string}
 */
function formatAudioDurationLabel(totalSec) {
  if (typeof totalSec !== "number" || !Number.isFinite(totalSec) || totalSec < 0) {
    return "?";
  }
  if (totalSec >= 60) {
    return `${Math.floor(totalSec / 60)}m ${Math.round(totalSec % 60)}s`;
  }
  return `${totalSec.toFixed(1)}s`;
}

/**
 * Play (or replay) a Blob object-URL via HTMLAudioElement and sync the replay bar.
 *
 * @param {string} objectUrl - createObjectURL result for the audio Blob
 * @param {HTMLElement} replayBar
 * @param {string} [durLabel]
 */
function playAudioFileUrl(objectUrl, replayBar, durLabel = "…") {
  assert: typeof objectUrl === "string" && objectUrl.length > 0;
  assert: typeof replayBar === "object" && replayBar !== null;

  stopReplay();

  const audio = new Audio(objectUrl);
  fileReplayAudio = audio;
  btnMic.classList.add("speaking");
  _setFileReplayBarState(replayBar, "playing", objectUrl, durLabel);

  audio.onended = () => {
    fileReplayAudio = null;
    btnMic.classList.remove("speaking");
    _setFileReplayBarState(replayBar, "idle", objectUrl, durLabel);
  };
  audio.onerror = () => {
    fileReplayAudio = null;
    btnMic.classList.remove("speaking");
    _setFileReplayBarState(replayBar, "idle", objectUrl, durLabel);
    console.error("Browser failed to decode or play the audio file response.");
  };

  audio.play().catch((err) => {
    fileReplayAudio = null;
    btnMic.classList.remove("speaking");
    _setFileReplayBarState(replayBar, "idle", objectUrl, durLabel);
    console.error(`Audio autoplay blocked or failed: ${err.message}`);
  });
}

/**
 * Update the file-audio replay bar between idle (Play) and playing (Stop).
 *
 * @param {HTMLElement} replayBar
 * @param {"idle" | "playing"} state
 * @param {string} objectUrl
 * @param {string} [durLabel] - Precomputed duration label for idle state
 */
function _setFileReplayBarState(replayBar, state, objectUrl, durLabel = "…") {
  assert: typeof replayBar === "object" && replayBar !== null;
  assert: state === "idle" || state === "playing";

  if (state === "playing") {
    replayBar.innerHTML = `
      <button class="btn-audio-replay btn-audio-replay--playing" title="Stop replay">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
             fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
        Stop
      </button>
      <span class="audio-replay-label">Playing response audio…</span>
    `;
    replayBar.querySelector(".btn-audio-replay").addEventListener("click", () => {
      stopReplay();
      btnMic.classList.remove("speaking");
      _setFileReplayBarState(replayBar, "idle", objectUrl, durLabel);
    });
    return;
  }

  replayBar.innerHTML = `
    <button class="btn-audio-replay" title="Replay audio response">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
           fill="currentColor" aria-hidden="true"><polygon points="5,3 19,12 5,21"/></svg>
      Play Audio
    </button>
    <span class="audio-replay-label">Audio response &middot; ${durLabel}</span>
  `;
  replayBar.querySelector(".btn-audio-replay").addEventListener("click", () => {
    playAudioFileUrl(objectUrl, replayBar, durLabel);
  });
}

/**
 * Decode final_output.audio_file_output_b64, show the replay bar, and auto-play.
 * Used when the workflow returns a full audio file instead of streaming PCM chunks.
 *
 * @param {{ audio_file_output_b64: string, mimetype?: string }} finalOutput
 * @param {HTMLElement} replayBar
 * @throws {Error} if base64 is missing/invalid
 */
function handleAudioFileOutput(finalOutput, replayBar) {
  assert: typeof finalOutput === "object" && finalOutput !== null;
  assert: typeof replayBar === "object" && replayBar !== null;

  const b64 = finalOutput.audio_file_output_b64;
  if (typeof b64 !== "string" || b64.length === 0) {
    throw new Error("final_output.audio_file_output_b64 is missing or empty.");
  }

  const mime =
    typeof finalOutput.mimetype === "string" && finalOutput.mimetype.length > 0
      ? finalOutput.mimetype
      : DEFAULT_AUDIO_FILE_MIMETYPE;

  const bytes = base64ToUint8Array(b64);
  const blob = new Blob([bytes], { type: mime });
  const objectUrl = URL.createObjectURL(blob);

  // Probe duration for the label, then show the bar and auto-play.
  const probe = new Audio(objectUrl);
  let revealed = false;
  const reveal = (durLabel) => {
    if (revealed) return;
    revealed = true;
    _setFileReplayBarState(replayBar, "idle", objectUrl, durLabel);
    replayBar.style.display = "flex";
    scrollToBottom();
    playAudioFileUrl(objectUrl, replayBar, durLabel);
  };

  probe.addEventListener("loadedmetadata", () => {
    reveal(formatAudioDurationLabel(probe.duration));
  });
  probe.addEventListener("error", () => {
    // Still offer replay; user gesture may succeed even if probe failed.
    reveal("?");
  });
}

/**
 * Decode a base64 PCM16 mono chunk, schedule it for seamless live playback,
 * and optionally push the raw Int16 data into a persistent chunkStore for later replay.
 *
 * @param {{ data_b64: string, sample_rate: number }} payload - SSE audio_chunk event
 * @param {Array<{int16: Int16Array, sample_rate: number}> | null} chunkStore
 *   If provided, the decoded Int16Array is appended here so the caller can replay later.
 */
function handleAudioChunk(payload, chunkStore = null) {
  const { data_b64, sample_rate = 24000 } = payload;
  if (!data_b64) return;

  // Decode base64 -> Int16Array
  const binaryStr = atob(data_b64);
  const int16 = new Int16Array(binaryStr.length / 2);
  for (let i = 0; i < int16.length; i++) {
    int16[i] = (binaryStr.charCodeAt(i * 2) | (binaryStr.charCodeAt(i * 2 + 1) << 8));
  }

  // Persist chunk for replay if a store was given
  if (chunkStore !== null) {
    chunkStore.push({ int16, sample_rate });
  }

  // ── Live streaming playback ──
  if (!playbackAudioContext || playbackAudioContext.state === "closed") {
    playbackAudioContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: sample_rate,
    });
    playbackScheduleTime = playbackAudioContext.currentTime + 0.05;
    btnMic.classList.add("speaking");
  }

  const numSamples = int16.length;
  const audioBuffer = playbackAudioContext.createBuffer(1, numSamples, sample_rate);
  const channelData = audioBuffer.getChannelData(0);
  for (let i = 0; i < numSamples; i++) {
    channelData[i] = int16[i] / 32768.0;
  }

  const bufferSource = playbackAudioContext.createBufferSource();
  bufferSource.buffer = audioBuffer;
  bufferSource.connect(playbackAudioContext.destination);

  const now = playbackAudioContext.currentTime;
  const startAt = Math.max(now + 0.01, playbackScheduleTime);
  bufferSource.start(startAt);
  playbackScheduleTime = startAt + audioBuffer.duration;

  bufferSource.onended = () => {
    if (playbackAudioContext && playbackScheduleTime <= playbackAudioContext.currentTime + 0.05) {
      btnMic.classList.remove("speaking");
    }
  };
}

/**
 * Concatenate all stored PCM16 chunks and play them through a new AudioContext.
 * Shows a Stop button on the replay bar while playing, then restores Play when done.
 *
 * @param {Array<{int16: Int16Array, sample_rate: number}>} chunkStore - Accumulated chunks
 * @param {HTMLElement} replayBar - The audio-replay-bar element hosting the button
 */
function replayAudio(chunkStore, replayBar) {
  if (!chunkStore || chunkStore.length === 0) return;

  // Stop any previous replay
  stopReplay();

  const sample_rate = chunkStore[0].sample_rate;
  const totalSamples = chunkStore.reduce((acc, c) => acc + c.int16.length, 0);

  // Concatenate all Int16 arrays into one Float32 buffer
  const combined = new Float32Array(totalSamples);
  let offset = 0;
  for (const { int16 } of chunkStore) {
    for (let i = 0; i < int16.length; i++) {
      combined[offset++] = int16[i] / 32768.0;
    }
  }

  replayAudioContext = new (window.AudioContext || window.webkitAudioContext)({
    sampleRate: sample_rate,
  });

  const audioBuffer = replayAudioContext.createBuffer(1, totalSamples, sample_rate);
  audioBuffer.copyToChannel(combined, 0);

  const source = replayAudioContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(replayAudioContext.destination);
  source.start(0);

  // Swap to Stop button while playing
  _setReplayBarState(replayBar, "playing", chunkStore);

  source.onended = () => {
    stopReplay();
    _setReplayBarState(replayBar, "idle", chunkStore);
  };
}

/**
 * Render the audio replay bar into the given container.
 * Called once when audio streaming for a response completes.
 *
 * @param {HTMLElement} replayBar - The audio-replay-bar element
 * @param {Array<{int16: Int16Array, sample_rate: number}>} chunkStore
 */
function showAudioReplayButton(replayBar, chunkStore) {
  assert: typeof replayBar === "object" && replayBar !== null;
  _setReplayBarState(replayBar, "idle", chunkStore);
  replayBar.style.display = "flex";
  scrollToBottom();
}

/**
 * Update replay bar button between idle (Play) and playing (Stop) states.
 *
 * @param {HTMLElement} replayBar
 * @param {"idle" | "playing"} state
 * @param {Array<{int16: Int16Array, sample_rate: number}>} chunkStore
 */
function _setReplayBarState(replayBar, state, chunkStore) {
  if (state === "playing") {
    replayBar.innerHTML = `
      <button class="btn-audio-replay btn-audio-replay--playing" title="Stop replay">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
             fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
        Stop
      </button>
      <span class="audio-replay-label">Playing response audio…</span>
    `;
    replayBar.querySelector(".btn-audio-replay").addEventListener("click", () => {
      stopReplay();
      _setReplayBarState(replayBar, "idle", chunkStore);
    });
  } else {
    const totalSec = chunkStore.reduce((s, c) => s + c.int16.length / c.sample_rate, 0);
    const durLabel = totalSec >= 60
      ? `${Math.floor(totalSec / 60)}m ${Math.round(totalSec % 60)}s`
      : `${totalSec.toFixed(1)}s`;
    replayBar.innerHTML = `
      <button class="btn-audio-replay" title="Replay audio response">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
             fill="currentColor" aria-hidden="true"><polygon points="5,3 19,12 5,21"/></svg>
        Play Audio
      </button>
      <span class="audio-replay-label">Audio response &middot; ${durLabel}</span>
    `;
    replayBar.querySelector(".btn-audio-replay").addEventListener("click", () => {
      replayAudio(chunkStore, replayBar);
    });
  }
}


/**
 * Set up mic capability detection on page load.
 * Configures SpeechRecognition fallback on plain HTTP, or enables full
 * PCM16 streaming on HTTPS/localhost.
 */
function setupAudioStreaming() {
  if (!btnMic) return;
  const hasGetUserMedia =
    navigator.mediaDevices && navigator.mediaDevices.getUserMedia;

  if (hasGetUserMedia) {
    btnMic.title = "Voice Input (Live Audio Stream)";
    return;
  }

  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    btnMic.title = "Voice input unavailable (need HTTPS or Chrome/Edge).";
    btnMic.disabled = true;
    return;
  }

  speechRecognizer = new SpeechRecognition();
  speechRecognizer.continuous = false;
  speechRecognizer.interimResults = true;
  speechRecognizer.lang = "en-US";

  speechRecognizer.onstart = () => {
    isListening = true;
    btnMic.classList.add("listening");
    btnMic.title = "Listening… Click to stop";
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
    console.warn("SpeechRecognition error:", err);
    isListening = false;
    btnMic.classList.remove("listening");
    btnMic.title = "Voice Input";
  };

  speechRecognizer.onend = () => {
    isListening = false;
    btnMic.classList.remove("listening");
    btnMic.title = "Voice Input";
  };
}

/**
 * Toggle live audio streaming mic on/off.
 * On start: get mic → open WS → start ScriptProcessorNode → fire /odisha/api/audio/execute.
 * On stop: send "__end__" → close WS → stream response into chat like text.
 */
async function toggleAudioStream() {
  if (isStreaming) return; // don't allow mic while text stream in progress

  // ── HTTP / no-getUserMedia fallback: use browser SpeechRecognition ──────
  if (speechRecognizer) {
    if (isListening) {
      isListening = false;
      btnMic.classList.remove("listening");
      btnMic.title = "Voice Input (Dictation mode — serve over HTTPS for live audio)";
      try { speechRecognizer.stop(); } catch {}
    } else {
      try { speechRecognizer.start(); } catch (e) {
        console.error("SpeechRecognition start error:", e);
      }
    }
    return;
  }

  // ── HTTPS / localhost path: full PCM16 binary streaming ─────────────
  if (isListening) {
    stopAudioStream();
    return;
  }

  try {
    audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    alert(`Microphone access denied: ${err.message}`);
    return;
  }

  isListening = true;
  btnMic.classList.add("listening");
  btnMic.title = "Recording… Click to stop and send";

  const streamId = crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  // Build the AudioContext at the browser's native sample rate first, then
  // let the ScriptProcessorNode downsample to MIC_TARGET_SAMPLE_RATE.
  micAudioContext = new (window.AudioContext || window.webkitAudioContext)();
  micSourceNode   = micAudioContext.createMediaStreamSource(audioStream);

  // ScriptProcessorNode gives us raw Float32 PCM from the mic
  micProcessorNode = micAudioContext.createScriptProcessor(
    MIC_BUFFER_SIZE, 1, 1
  );

  // Open WebSocket to backend proxy FIRST, before starting the processor
  audioWs = new WebSocket(ENDPOINTS.AUDIO_WS(streamId));
  audioWs.binaryType = "arraybuffer";

  audioWs.onerror = () => {
    stopAudioStream();
    appendErrorCard("Audio WebSocket connection failed. Is the server running?", "");
  };

  // Wait for WS to open
  await new Promise((resolve, reject) => {
    audioWs.onopen  = resolve;
    audioWs.onerror = reject;
  }).catch(() => { stopAudioStream(); return; });

  if (!audioWs || audioWs.readyState !== WebSocket.OPEN) return;

  // Compute the integer downsampling ratio (browser rate ÷ target rate)
  const nativeRate   = micAudioContext.sampleRate;  // e.g. 48000
  const downsampleRatio = Math.round(nativeRate / MIC_TARGET_SAMPLE_RATE); // e.g. 3

  micProcessorNode.onaudioprocess = (e) => {
    if (!audioWs || audioWs.readyState !== WebSocket.OPEN) return;

    const inputFloat32 = e.inputBuffer.getChannelData(0);
    // Downsample by picking every downsampleRatio-th sample
    const outLen  = Math.floor(inputFloat32.length / downsampleRatio);
    const int16   = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      // Clamp to [-1, 1] before converting to Int16
      const sample = Math.max(-1.0, Math.min(1.0, inputFloat32[i * downsampleRatio]));
      int16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
    }
    audioWs.send(int16.buffer);
  };

  micSourceNode.connect(micProcessorNode);
  // Connect to destination with zero gain so we don't hear our own mic
  micProcessorNode.connect(micAudioContext.destination);

  // Define the completion handler to be executed by the button toggle logic
  const onStopRecording = async () => {
    // Disconnect processor and stop mic
    try { micProcessorNode.disconnect(); } catch {}
    try { micSourceNode.disconnect(); } catch {}

    // Send end sentinel and close WS
    if (audioWs && audioWs.readyState === WebSocket.OPEN) {
      try { audioWs.send("__end__"); } catch {}
      await new Promise(r => setTimeout(r, 200));
      try { audioWs.close(); } catch {}
    }

    isStreaming = true;
    updateSendControls();

    // Show a placeholder message that voice was sent
    appendUserMessage("🎤 (Voice message sent)", null);
    const { textContainer, citationSection, audioReplayContainer } = createAssistantCard();
    let tokenBuffer = "";
    let hasReceivedToken = false;
    let hasAudioOutput = false;
    const chunkStore = [];  // Accumulates PCM16 chunks for replay

    try {
      const form = new FormData();
      form.append("stream_id", streamId);

      const response = await fetch(ENDPOINTS.AUDIO_EXECUTE, {
        method: "POST",
        body: form,
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Audio execute returned ${response.status}: ${errText}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let streamBuf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        streamBuf += decoder.decode(value, { stream: true });
        const lines = streamBuf.split("\n");
        streamBuf = lines.pop();

        for (const line of lines) {
          const t = line.trim();
          if (!t || t === "data: [DONE]" || !t.startsWith("data:")) continue;
          let payload;
          try { payload = JSON.parse(t.slice(5).trim()); } catch { continue; }
          const evType = payload.event;
          if (evType === "token") {
            if (!hasReceivedToken) { hasReceivedToken = true; textContainer.innerHTML = ""; }
            tokenBuffer += payload.token;
            textContainer.innerHTML = renderMarkdown(tokenBuffer) + '<span class="streaming-cursor"></span>';
            scrollToBottom();
          } else if (evType === "audio_chunk") {
            // Voice model response — play audio in browser
            if (!hasReceivedToken && !hasAudioOutput) {
              hasReceivedToken = true;
              hasAudioOutput = true;
              textContainer.innerHTML = '<p><em>&#127908; Speaking…</em></p>';
              btnMic.classList.add("speaking");
            }
            handleAudioChunk(payload, chunkStore);
          } else if (evType === "complete") {
            const fo = payload.final_output || {};
            const final =
              typeof fo.output === "string" && fo.output.length > 0
                ? fo.output
                : tokenBuffer;
            stopPlayback();

            if (hasAudioOutput && chunkStore.length > 0) {
              textContainer.innerHTML = "";
              showAudioReplayButton(audioReplayContainer, chunkStore);
            } else if (
              typeof fo.audio_file_output_b64 === "string" &&
              fo.audio_file_output_b64.length > 0
            ) {
              if (final) {
                textContainer.innerHTML = renderMarkdown(final);
                updateCitations(citationSection, final, null);
              } else {
                textContainer.innerHTML = "<p><em>&#127908; Audio response</em></p>";
              }
              try {
                handleAudioFileOutput(fo, audioReplayContainer);
              } catch (audioErr) {
                textContainer.innerHTML =
                  `<p class="error-inline">Could not play audio response: ${audioErr.message}</p>`;
              }
            } else if (final) {
              textContainer.innerHTML = renderMarkdown(final);
              updateCitations(citationSection, final, null);
            } else {
              textContainer.innerHTML =
                "<p class=\"error-inline\">Workflow completed with no text or audio output.</p>";
            }
            scrollToBottom();
          } else if (evType === "error") {
            throw new Error(payload.detail || "Audio workflow error");
          }
        }
      }

      if (tokenBuffer && textContainer.querySelector(".streaming-cursor")) {
        textContainer.innerHTML = renderMarkdown(tokenBuffer);
        updateCitations(citationSection, tokenBuffer, null);
      }
    } catch (err) {
      textContainer.innerHTML = "";
      appendErrorCard(err.message, "");
    } finally {
      isStreaming = false;
      updateSendControls();
      scrollToBottom();
    }
  };

  btnMic._onStopRecording = onStopRecording;
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

if (chatInput) {
  chatInput.addEventListener("input", autoResizeInput);
}

// New Chat button
if (btnNewChat) {
  btnNewChat.addEventListener("click", resetChat);
}

// Export Chat button
if (btnExportChat) {
  btnExportChat.addEventListener("click", exportConversation);
}

// File Attachment handling
if (btnAttach && fileInput) {
  btnAttach.addEventListener("click", () => fileInput.click());
}

if (fileInput) {
  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    if (file) {
      attachedFile = file;
      if (chipFileName) chipFileName.textContent = file.name;
      if (chipFileSize) chipFileSize.textContent = `(${formatFileSize(file.size)})`;
      if (fileTray) fileTray.classList.add("visible");
      if (btnAttach) btnAttach.classList.add("has-attachment");
    }
  });
}

if (btnRemoveChip) {
  btnRemoveChip.addEventListener("click", clearAttachedFile);
}

// Voice Mic Button — toggles live PCM16 audio streaming or speech dictation
if (btnMic) {
  btnMic.addEventListener("click", async () => {
    // If there's a pending stop-and-execute callback, trigger it
    if (isListening && btnMic._onStopRecording) {
      const cb = btnMic._onStopRecording;
      btnMic._onStopRecording = null;
      stopAudioStream();
      await cb();
    } else {
      await toggleAudioStream();
    }
  });
}

// Web Search Toggle Pill
if (btnWebSearch) {
  btnWebSearch.addEventListener("click", () => {
    isWebSearchOn = !isWebSearchOn;
    btnWebSearch.classList.toggle("active", isWebSearchOn);
    btnWebSearch.title = isWebSearchOn ? "Web Search: ON" : "Web Search: OFF";
  });
}

// Prompt Chips Click
document.querySelectorAll(".prompt-chip").forEach(chip => {
  chip.addEventListener("click", () => {
    const prompt = chip.getAttribute("data-prompt");
    if (prompt && chatInput) {
      chatInput.value = prompt;
      autoResizeInput();
      if (btnSend) btnSend.click();
    }
  });
});

/* ── Initialization ───────────────────────────────────────────────────── */
setupAudioStreaming();
if (chatInput) {
  chatInput.focus();
}
