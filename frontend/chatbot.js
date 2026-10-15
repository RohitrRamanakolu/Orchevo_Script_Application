/**
 * Odisha Govt Chatbot Client
 * Dual input:
 *   - Text (+ optional attach) via /odisha/chat/stream
 *   - Mic: live 16 kHz PCM over WebSocket + /odisha/audio/execute
 *     (stream_refs → audio_stream Start var from script.py, e.g. audio_input_stream)
 * SpeechRecognition shows a live user transcript; SSE relays text/audio replies.
 *
 * Audio Architecture:
 * - INPUT (mic): ScriptProcessorNode → PCM16 @ 16 kHz → WS audio/stream/{id}
 * - OUTPUT (streamed): SSE audio_chunk events (base64 PCM16 @ sample_rate)
 * - OUTPUT (file):    audio_file_output_b64 / audio_file_output_public_url
 */

/* ── Constants ────────────────────────────────────────────────────────── */
const API_BASE = window.location.origin;
const WS_BASE = API_BASE.replace(/^https/, "wss").replace(/^http/, "ws");
/** Must match backend ``_API_PREFIX`` in main.py. */
const API_PREFIX = "/odisha";
const ENDPOINTS = Object.freeze({
  CHAT_STREAM:    `${API_BASE}${API_PREFIX}/chat/stream`,
  AUDIO_EXECUTE:  `${API_BASE}${API_PREFIX}/audio/execute`,
  AUDIO_WS:       (streamId) => `${WS_BASE}${API_PREFIX}/audio/stream/${streamId}`,
  HEALTH:         `${API_BASE}${API_PREFIX}/health-check`,
});

/** Mic / live-stream sample rate required by Paradigm audio_stream STT. */
const MIC_TARGET_SAMPLE_RATE = 16000;
/** ScriptProcessorNode buffer size — must be a power of two; 4096 ≈ 256 ms at 16 kHz. */
const MIC_BUFFER_SIZE = 4096;
/** Fallback MIME when complete.final_output.mimetype is absent (Paradigm WAV files). */
const DEFAULT_AUDIO_FILE_MIMETYPE = "audio/wav";
/** Browser SpeechRecognition language for on-device user transcript display. */
const USER_TRANSCRIPT_LANG = "en-IN";
/** Idle / status copy shown under the mic. */
const VOICE_STATUS = Object.freeze({
  IDLE:       "Tap the microphone to speak",
  LISTENING:  "Listening… tap mic or Send to submit",
  PROCESSING: "Thinking…",
  SPEAKING:   "Speaking…",
  UNAVAILABLE:"Voice input unavailable (need HTTPS or Chrome/Edge)",
});

const AUTO_SCROLL_THRESHOLD_PX = 140;
const MAX_TEXTAREA_HEIGHT_PX   = 160;

/* ── Application State ────────────────────────────────────────────────── */
let isStreaming     = false;
let abortController = null;
let attachedFile    = null;
let isListening     = false;

// Live mic streaming state (PCM16 → WebSocket → stream_refs)
let audioWs              = null;   // WebSocket to backend audio proxy
let micAudioContext      = null;   // AudioContext for mic capture
let micSourceNode        = null;   // MediaStreamAudioSourceNode
let micProcessorNode     = null;   // ScriptProcessorNode (downsamples to 16 kHz)
let audioStream          = null;   // getUserMedia stream handle (raw tracks)
let playbackAudioContext = null;   // AudioContext for live streaming PCM16 playback
let playbackScheduleTime = 0;      // Seconds on the playback clock scheduled so far
let replayAudioContext   = null;   // AudioContext for replay (kept separate from live stream)
let fileReplayAudio      = null;   // HTMLAudioElement for audio_file_output_b64 replay
let userSpeechRecognizer = null;   // Parallel SpeechRecognition for user transcript
let transcriptFinalParts = [];     // Finalized SpeechRecognition segments
let transcriptInterim    = "";     // Current interim SpeechRecognition segment

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
const voiceStatusEl    = document.getElementById("voice-status");
const liveTranscriptEl = document.getElementById("live-transcript");
const btnNewChat       = document.getElementById("btn-new-chat");
const btnExportChat    = document.getElementById("btn-export-chat");

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
  scrollToBottom(true);
}

/**
 * Create an Assistant response card with text area and optional audio replay.
 *
 * @returns {{ row: HTMLElement, textContainer: HTMLElement, audioReplayContainer: HTMLElement }}
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

  // Audio replay toolbar (hidden until audio response completes)
  const audioReplayContainer = document.createElement("div");
  audioReplayContainer.className = "audio-replay-bar";
  audioReplayContainer.style.display = "none";

  cardEl.appendChild(textContainer);
  cardEl.appendChild(audioReplayContainer);

  rowEl.innerHTML = `<div class="msg-avatar-ai">AI</div>`;
  rowEl.appendChild(cardEl);
  messagesList.appendChild(rowEl);
  scrollToBottom(true);

  return { row: rowEl, textContainer, audioReplayContainer };
}

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
 * Stream a chat/voice turn from the backend.
 * @param {string} query  Text prompt; may be empty when ``fileOverride`` is set (mic WAV).
 * @param {File | null} [fileOverride]  Optional file to send instead of ``attachedFile``.
 * @param {string} [displayOverride]  Bubble label when query is empty (voice turns).
 */
async function sendMessage(query, fileOverride, displayOverride) {
  const trimmed = typeof query === "string" ? query.trim() : "";
  const fileToSend =
    fileOverride instanceof File ? fileOverride : attachedFile;
  if (isStreaming) return;
  if (!trimmed && !(fileToSend instanceof File)) return;

  isStreaming = true;
  updateSendControls();

  const displayText =
    (typeof displayOverride === "string" && displayOverride.trim().length > 0)
      ? displayOverride.trim()
      : (trimmed.length > 0
        ? trimmed
        : (fileToSend && fileToSend.name) || "Voice message");
  appendUserMessage(displayText, fileToSend);
  if (!(fileOverride instanceof File)) {
    clearAttachedFile();
  }

  const { textContainer, audioReplayContainer } = createAssistantCard();
  scrollToBottom(true);

  let tokenBuffer = "";
  let hasReceivedToken = false;
  let hasAudioOutput = false;
  const chunkStore = [];  // Accumulates PCM16 chunks for post-stream replay

  try {
    abortController = new AbortController();

    const form = new FormData();
    form.append("query", trimmed);
    if (fileToSend instanceof File) {
      form.append("file", fileToSend, fileToSend.name || "upload.bin");
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
          if (!hasAudioOutput) {
            hasAudioOutput = true;
            if (!hasReceivedToken) {
              hasReceivedToken = true;
              textContainer.innerHTML = '<p><em>&#127908; Speaking…</em></p>';
            }
            if (btnMic) btnMic.classList.add("speaking");
          }
          handleAudioChunk(eventPayload, chunkStore);
        } else if (evType === "complete") {
          const fo = eventPayload.final_output || {};
          stopPlayback();
          applyAssistantCompleteOutput({
            finalOutput: fo,
            tokenBuffer,
            textContainer,
            audioReplayContainer,
            chunkStore,
            hasStreamedAudio: hasAudioOutput,
          });
          scrollToBottom();
        } else if (evType === "error") {
          throw new Error(eventPayload.detail || "Workflow execution encountered an unexpected error.");
        }
      }
    }

    // Clean up cursor if finished cleanly
    if (!hasAudioOutput && tokenBuffer && textContainer.querySelector(".streaming-cursor")) {
      textContainer.innerHTML = renderMarkdown(tokenBuffer);
    }

  } catch (err) {
    if (err.name === "AbortError") {
      if (tokenBuffer) {
        textContainer.innerHTML = renderMarkdown(tokenBuffer);
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

/**
 * Scroll the chat viewport to the latest message.
 * Prefers ``scrollIntoView`` on the last row; retries after layout frames.
 *
 * @param {boolean} [force=false]  Always scroll; ignore near-bottom threshold.
 */
function scrollToBottom(force) {
  assert: chatViewport instanceof HTMLElement;
  const dist =
    chatViewport.scrollHeight - chatViewport.scrollTop - chatViewport.clientHeight;
  const shouldScroll =
    Boolean(force) || isStreaming || dist < AUTO_SCROLL_THRESHOLD_PX;
  if (!shouldScroll) return;

  const apply = () => {
    const lastRow = messagesList
      ? messagesList.querySelector(".msg-row:last-child")
      : null;
    if (lastRow instanceof HTMLElement) {
      lastRow.scrollIntoView({ block: "end", inline: "nearest", behavior: "auto" });
    }
    chatViewport.scrollTop = chatViewport.scrollHeight;
  };
  apply();
  requestAnimationFrame(() => {
    apply();
    requestAnimationFrame(apply);
  });
}

/**
 * Update send / mic affordances while a response stream is in flight.
 */
function updateSendControls() {
  if (btnSend) {
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
  if (btnMic) {
    btnMic.disabled = Boolean(isStreaming);
    if (isStreaming) {
      setVoiceStatus(VOICE_STATUS.PROCESSING);
    } else if (!isListening) {
      setVoiceStatus(VOICE_STATUS.IDLE);
      btnMic.title = "Voice input";
    }
  }
}

/** Auto-resize textarea to fit typed content. */
function autoResizeInput() {
  if (!chatInput) return;
  chatInput.style.height = "auto";
  chatInput.style.height = Math.min(chatInput.scrollHeight, MAX_TEXTAREA_HEIGHT_PX) + "px";
}

/** Clear attached file and reset the file-chip UI. */
function clearAttachedFile() {
  attachedFile = null;
  if (fileInput) fileInput.value = "";
  if (fileTray) fileTray.classList.remove("visible");
  if (btnAttach) btnAttach.classList.remove("has-attachment");
}

/**
 * Update the status label under the mic.
 * @param {string} text
 */
function setVoiceStatus(text) {
  assert: typeof text === "string";
  if (!voiceStatusEl) return;
  voiceStatusEl.textContent = text;
}

/**
 * Show or clear the live interim user transcript above the mic.
 * @param {string} text
 */
function setLiveTranscript(text) {
  assert: typeof text === "string";
  if (!liveTranscriptEl) return;
  const trimmed = text.trim();
  liveTranscriptEl.textContent = trimmed;
  liveTranscriptEl.classList.toggle("visible", trimmed.length > 0);
}

/**
 * Return the browser SpeechRecognition constructor, or null if unsupported.
 * @returns {typeof SpeechRecognition | null}
 */
function getSpeechRecognitionCtor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

/**
 * Start on-device SpeechRecognition in parallel with PCM streaming so we can
 * display what the user said. Does not affect the audio sent to Paradigm.
 */
function startUserTranscriptCapture() {
  const Ctor = getSpeechRecognitionCtor();
  transcriptFinalParts = [];
  transcriptInterim = "";
  setLiveTranscript("");

  if (!Ctor) {
    setVoiceStatus(VOICE_STATUS.LISTENING);
    return;
  }

  userSpeechRecognizer = new Ctor();
  userSpeechRecognizer.continuous = true;
  userSpeechRecognizer.interimResults = true;
  userSpeechRecognizer.lang = USER_TRANSCRIPT_LANG;

  userSpeechRecognizer.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const piece = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        const cleaned = piece.trim();
        if (cleaned) transcriptFinalParts.push(cleaned);
      } else {
        interim += piece;
      }
    }
    transcriptInterim = interim;
    const display = [...transcriptFinalParts, transcriptInterim]
      .filter((p) => typeof p === "string" && p.trim().length > 0)
      .join(" ");
    setLiveTranscript(display);
  };

  userSpeechRecognizer.onerror = (err) => {
    // nonetwork / no-speech are common; keep PCM path alive and surface quietly.
    console.warn("User transcript SpeechRecognition error:", err.error || err);
  };

  try {
    userSpeechRecognizer.start();
  } catch (err) {
    console.error("Failed to start user transcript capture:", err);
    userSpeechRecognizer = null;
  }
}

/**
 * Stop parallel SpeechRecognition and return the best available transcript.
 * @returns {string} Finalized (+ trailing interim) transcript, may be empty
 */
function stopUserTranscriptCapture() {
  const text = [...transcriptFinalParts, transcriptInterim]
    .filter((p) => typeof p === "string" && p.trim().length > 0)
    .join(" ")
    .trim();

  if (userSpeechRecognizer !== null) {
    try { userSpeechRecognizer.onresult = null; } catch {}
    try { userSpeechRecognizer.stop(); } catch {}
    userSpeechRecognizer = null;
  }
  transcriptFinalParts = [];
  transcriptInterim = "";
  return text;
}

/** Reset entire chat conversation. */
function resetChat() {
  if (isStreaming && abortController) {
    abortController.abort();
  }
  isStreaming = false;
  abortController = null;
  stopUserTranscriptCapture();
  setLiveTranscript("");
  messagesList.innerHTML = "";
  messagesList.style.display = "none";
  welcomeHero.style.display = "flex";
  clearAttachedFile();
  if (chatInput) {
    chatInput.value = "";
    autoResizeInput();
    chatInput.focus();
  }
  updateSendControls();
}

/** Stop and clean up an active live mic capture + WebSocket session. */
function stopAudioStream() {
  isListening = false;
  if (btnMic) {
    btnMic.classList.remove("listening");
    btnMic.classList.remove("speaking");
    btnMic.title = "Voice input";
  }
  if (!isStreaming) {
    setVoiceStatus(VOICE_STATUS.IDLE);
  }

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
  if (audioStream) {
    audioStream.getTracks().forEach((t) => t.stop());
    audioStream = null;
  }
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
  if (btnMic) btnMic.classList.remove("speaking");
  if (!isListening && !isStreaming) {
    setVoiceStatus(VOICE_STATUS.IDLE);
  }
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
    if (btnMic) btnMic.classList.remove("speaking");
    if (!isListening && !isStreaming) setVoiceStatus(VOICE_STATUS.IDLE);
    _setFileReplayBarState(replayBar, "idle", objectUrl, durLabel);
  };
  audio.onerror = () => {
    fileReplayAudio = null;
    if (btnMic) btnMic.classList.remove("speaking");
    if (!isListening && !isStreaming) setVoiceStatus(VOICE_STATUS.IDLE);
    _setFileReplayBarState(replayBar, "idle", objectUrl, durLabel);
    console.error("Browser failed to decode or play the audio file response.");
  };

  audio.play().catch((err) => {
    fileReplayAudio = null;
    if (btnMic) btnMic.classList.remove("speaking");
    if (!isListening && !isStreaming) setVoiceStatus(VOICE_STATUS.IDLE);
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
 * Render text and voice together from a workflow ``complete`` payload.
 * Multi-output turns keep both: markdown text plus stream and/or file audio.
 *
 * @param {object} opts
 * @param {Record<string, unknown>} opts.finalOutput
 * @param {string} opts.tokenBuffer
 * @param {HTMLElement} opts.textContainer
 * @param {HTMLElement} opts.audioReplayContainer
 * @param {Array} opts.chunkStore
 * @param {boolean} opts.hasStreamedAudio
 * @param {boolean} [opts.markSpeaking]
 */
function applyAssistantCompleteOutput(opts) {
  assert: typeof opts === "object" && opts !== null;
  const finalOutput = opts.finalOutput && typeof opts.finalOutput === "object"
    ? opts.finalOutput
    : {};
  const tokenBuffer = typeof opts.tokenBuffer === "string" ? opts.tokenBuffer : "";
  const textContainer = opts.textContainer;
  const audioReplayContainer = opts.audioReplayContainer;
  const chunkStore = Array.isArray(opts.chunkStore) ? opts.chunkStore : [];
  assert: textContainer instanceof HTMLElement;
  assert: audioReplayContainer instanceof HTMLElement;

  const finalText =
    typeof finalOutput.output === "string" && finalOutput.output.length > 0
      ? finalOutput.output
      : tokenBuffer;
  const hasText = typeof finalText === "string" && finalText.trim().length > 0;
  const hasStreamAudio = Boolean(opts.hasStreamedAudio) && chunkStore.length > 0;
  const hasFileAudio = hasAudioFileResponse(finalOutput);

  if (hasText) {
    textContainer.innerHTML = renderMarkdown(finalText);
  } else if (hasStreamAudio || hasFileAudio) {
    textContainer.innerHTML = "<p><em>&#127908; Audio response</em></p>";
  } else {
    textContainer.innerHTML =
      "<p class=\"error-inline\">Workflow completed with no text or audio output.</p>";
  }

  if (hasStreamAudio) {
    showAudioReplayButton(audioReplayContainer, chunkStore);
  }

  if (hasFileAudio) {
    try {
      handleAudioFileOutput(finalOutput, audioReplayContainer);
      if (opts.markSpeaking) {
        setVoiceStatus(VOICE_STATUS.SPEAKING);
      }
    } catch (audioErr) {
      const prior = hasText ? textContainer.innerHTML : "";
      textContainer.innerHTML =
        prior +
        `<p class="error-inline">Could not play audio response: ${audioErr.message}</p>`;
    }
  }
}

/**
 * True when final_output includes a playable file-audio payload (b64 and/or URL).
 *
 * @param {Record<string, unknown>} finalOutput
 * @returns {boolean}
 */
function hasAudioFileResponse(finalOutput) {
  assert: typeof finalOutput === "object" && finalOutput !== null;
  const b64 = finalOutput.audio_file_output_b64;
  const publicUrl = finalOutput.audio_file_output_public_url;
  const hasB64 = typeof b64 === "string" && b64.length > 0;
  const hasUrl = typeof publicUrl === "string" && publicUrl.length > 0;
  return hasB64 || hasUrl;
}

/**
 * Resolve MIME type from Paradigm field names (new or legacy).
 *
 * @param {Record<string, unknown>} finalOutput
 * @returns {string}
 */
function resolveAudioFileMime(finalOutput) {
  assert: typeof finalOutput === "object" && finalOutput !== null;
  if (
    typeof finalOutput.audio_file_output_mimetype === "string" &&
    finalOutput.audio_file_output_mimetype.length > 0
  ) {
    return finalOutput.audio_file_output_mimetype;
  }
  if (typeof finalOutput.mimetype === "string" && finalOutput.mimetype.length > 0) {
    return finalOutput.mimetype;
  }
  return DEFAULT_AUDIO_FILE_MIMETYPE;
}

/**
 * Build a browser-playable URL from final_output file-audio fields.
 * Prefers base64 (Blob URL); otherwise uses audio_file_output_public_url.
 *
 * @param {Record<string, unknown>} finalOutput
 * @returns {string}
 * @throws {Error} if neither b64 nor public URL is present/valid
 */
function resolvePlayableAudioUrl(finalOutput) {
  assert: typeof finalOutput === "object" && finalOutput !== null;

  const b64 = finalOutput.audio_file_output_b64;
  if (typeof b64 === "string" && b64.length > 0) {
    const mime = resolveAudioFileMime(finalOutput);
    const bytes = base64ToUint8Array(b64);
    return URL.createObjectURL(new Blob([bytes], { type: mime }));
  }

  const publicUrl = finalOutput.audio_file_output_public_url;
  if (typeof publicUrl === "string" && publicUrl.length > 0) {
    return publicUrl;
  }

  throw new Error(
    "final_output has neither audio_file_output_b64 nor audio_file_output_public_url."
  );
}

/**
 * Play file-audio from final_output (base64 Blob and/or public URL), show replay bar.
 * Used when the workflow returns a full audio file instead of streaming PCM chunks.
 *
 * @param {Record<string, unknown>} finalOutput
 * @param {HTMLElement} replayBar
 * @throws {Error} if no playable audio fields are present
 */
function handleAudioFileOutput(finalOutput, replayBar) {
  assert: typeof finalOutput === "object" && finalOutput !== null;
  assert: typeof replayBar === "object" && replayBar !== null;

  const playableUrl = resolvePlayableAudioUrl(finalOutput);
  assert: typeof playableUrl === "string" && playableUrl.length > 0;

  const probe = new Audio(playableUrl);
  let revealed = false;
  const reveal = (durLabel) => {
    if (revealed) return;
    revealed = true;
    _setFileReplayBarState(replayBar, "idle", playableUrl, durLabel);
    replayBar.style.display = "flex";
    scrollToBottom();
    playAudioFileUrl(playableUrl, replayBar, durLabel);
  };

  probe.addEventListener("loadedmetadata", () => {
    reveal(formatAudioDurationLabel(probe.duration));
  });
  probe.addEventListener("error", () => {
    // Public URLs can fail CORS/metadata probe; still expose Play for a user gesture.
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
 * Live mic needs getUserMedia + WebSocket to /odisha/audio/stream/{id}.
 */
function setupAudioStreaming() {
  if (!btnMic) return;
  const hasGetUserMedia =
    navigator.mediaDevices && navigator.mediaDevices.getUserMedia;

  if (hasGetUserMedia) {
    btnMic.title = "Tap to speak";
    setVoiceStatus(VOICE_STATUS.IDLE);
    return;
  }

  btnMic.title = VOICE_STATUS.UNAVAILABLE;
  btnMic.disabled = true;
  setVoiceStatus(VOICE_STATUS.UNAVAILABLE);
}

/**
 * Toggle live audio streaming mic on/off.
 * On start: get mic → open WS → stream PCM16 + transcript capture.
 * On stop: end sentinel → POST /audio/execute with stream_id (stream_refs).
 */
async function toggleAudioStream() {
  if (isStreaming) return;

  if (isListening) {
    stopAudioStream();
    return;
  }

  try {
    audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    appendErrorCard(`Microphone access denied: ${err.message}`, "");
    return;
  }

  isListening = true;
  btnMic.classList.add("listening");
  btnMic.title = "Listening… tap mic or Send to submit";
  if (btnSend) btnSend.title = "Send voice message";
  setVoiceStatus(VOICE_STATUS.LISTENING);
  startUserTranscriptCapture();

  const streamId = crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  micAudioContext = new (window.AudioContext || window.webkitAudioContext)();
  micSourceNode = micAudioContext.createMediaStreamSource(audioStream);
  micProcessorNode = micAudioContext.createScriptProcessor(MIC_BUFFER_SIZE, 1, 1);

  audioWs = new WebSocket(ENDPOINTS.AUDIO_WS(streamId));
  audioWs.binaryType = "arraybuffer";

  audioWs.onerror = () => {
    stopUserTranscriptCapture();
    setLiveTranscript("");
    stopAudioStream();
    appendErrorCard("Audio WebSocket connection failed. Is the server running?", "");
  };

  await new Promise((resolve, reject) => {
    audioWs.onopen = resolve;
    audioWs.onerror = reject;
  }).catch(() => {
    stopUserTranscriptCapture();
    setLiveTranscript("");
    stopAudioStream();
  });

  if (!audioWs || audioWs.readyState !== WebSocket.OPEN) return;

  const nativeRate = micAudioContext.sampleRate;
  const downsampleRatio = Math.max(1, Math.round(nativeRate / MIC_TARGET_SAMPLE_RATE));

  micProcessorNode.onaudioprocess = (e) => {
    if (!audioWs || audioWs.readyState !== WebSocket.OPEN) return;
    const inputFloat32 = e.inputBuffer.getChannelData(0);
    const outLen = Math.floor(inputFloat32.length / downsampleRatio);
    if (outLen <= 0) return;
    const int16 = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const sample = Math.max(-1.0, Math.min(1.0, inputFloat32[i * downsampleRatio]));
      int16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
    }
    audioWs.send(int16.buffer);
  };

  micSourceNode.connect(micProcessorNode);
  micProcessorNode.connect(micAudioContext.destination);

  /**
   * @param {string} userTranscript
   */
  const onStopRecording = async (userTranscript) => {
    assert: typeof userTranscript === "string";

    try { micProcessorNode && micProcessorNode.disconnect(); } catch {}
    try { micSourceNode && micSourceNode.disconnect(); } catch {}

    if (audioWs && audioWs.readyState === WebSocket.OPEN) {
      try { audioWs.send("__end__"); } catch {}
      await new Promise((r) => setTimeout(r, 200));
      try { audioWs.close(); } catch {}
    }
    audioWs = null;

    isStreaming = true;
    updateSendControls();
    setLiveTranscript("");

    const displayText =
      userTranscript.trim().length > 0
        ? userTranscript.trim()
        : "Voice message (transcript unavailable)";
    appendUserMessage(displayText, null);

    const { textContainer, audioReplayContainer } = createAssistantCard();
    let tokenBuffer = "";
    let hasReceivedToken = false;
    let hasAudioOutput = false;
    const chunkStore = [];

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
            if (!hasAudioOutput) {
              hasAudioOutput = true;
              if (!hasReceivedToken) {
                hasReceivedToken = true;
                textContainer.innerHTML = '<p><em>&#127908; Speaking…</em></p>';
              }
              if (btnMic) btnMic.classList.add("speaking");
              setVoiceStatus(VOICE_STATUS.SPEAKING);
            }
            handleAudioChunk(payload, chunkStore);
          } else if (evType === "complete") {
            const fo = payload.final_output || {};
            stopPlayback();
            applyAssistantCompleteOutput({
              finalOutput: fo,
              tokenBuffer,
              textContainer,
              audioReplayContainer,
              chunkStore,
              hasStreamedAudio: hasAudioOutput,
              markSpeaking: true,
            });
            scrollToBottom();
          } else if (evType === "error") {
            throw new Error(payload.detail || "Audio workflow error");
          }
        }
      }

      if (tokenBuffer && textContainer.querySelector(".streaming-cursor")) {
        textContainer.innerHTML = renderMarkdown(tokenBuffer);
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

/**
 * Finalize an active live-mic session and run ``/audio/execute``.
 * Shared by a second mic tap and the Send button / Enter key.
 *
 * @returns {Promise<boolean>} ``true`` when a recording was submitted.
 */
async function submitLiveMicRecording() {
  if (!isListening) return false;
  if (!btnMic || typeof btnMic._onStopRecording !== "function") return false;

  const onStop = btnMic._onStopRecording;
  btnMic._onStopRecording = null;
  const userTranscript = stopUserTranscriptCapture();
  stopAudioStream();
  await onStop(userTranscript);
  return true;
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

if (btnSend) {
  btnSend.addEventListener("click", async () => {
    if (isStreaming) {
      if (abortController) abortController.abort();
      return;
    }
    // Mic is live: Send finalizes the recording (same as tapping mic again).
    if (isListening) {
      await submitLiveMicRecording();
      return;
    }
    if (!chatInput) return;
    const query = chatInput.value.trim();
    if (!query) return;
    chatInput.value = "";
    autoResizeInput();
    sendMessage(query);
  });
}

if (chatInput) {
  chatInput.addEventListener("keydown", async (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (isStreaming) return;
      if (isListening) {
        await submitLiveMicRecording();
        return;
      }
      const query = chatInput.value.trim();
      if (!query) return;
      chatInput.value = "";
      autoResizeInput();
      sendMessage(query);
    }
  });
  chatInput.addEventListener("input", autoResizeInput);
}

if (btnNewChat) {
  btnNewChat.addEventListener("click", resetChat);
}

if (btnExportChat) {
  btnExportChat.addEventListener("click", exportConversation);
}

if (btnAttach && fileInput) {
  btnAttach.addEventListener("click", () => fileInput.click());
}

if (fileInput) {
  fileInput.addEventListener("change", () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    attachedFile = file;
    if (chipFileName) chipFileName.textContent = file.name;
    if (chipFileSize) chipFileSize.textContent = `(${formatFileSize(file.size)})`;
    if (fileTray) fileTray.classList.add("visible");
    if (btnAttach) btnAttach.classList.add("has-attachment");
  });
}

if (btnRemoveChip) {
  btnRemoveChip.addEventListener("click", clearAttachedFile);
}

// Mic — start/stop live PCM16 streaming; capture transcript before tear-down
if (btnMic) {
  btnMic.addEventListener("click", async () => {
    if (isStreaming) return;

    if (isListening) {
      await submitLiveMicRecording();
      return;
    }

    await toggleAudioStream();
  });
}

/* ── Initialization ───────────────────────────────────────────────────── */
setupAudioStreaming();
updateSendControls();
if (chatInput) {
  chatInput.focus();
}
