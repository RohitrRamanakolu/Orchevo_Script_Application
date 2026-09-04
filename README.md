# Orchevo Script Application

A full-stack chat application built to dynamically execute AI agent workflows from the Paradigm Platform.

This repository features a modern, government-themed chat UI and a robust Python backend that securely parses and executes any published Python workflow snippet. 

## Features

- **Universal Script Compatibility**: The backend uses an Abstract Syntax Tree (AST) parser to dynamically analyze and inject variables into any downloaded `script.py`, regardless of what input names the workflow uses.
- **Session Continuity**: Retains your conversation context across multiple chat messages by preserving the platform session ID in the backend.
- **Real-time SSE Streaming**: Instantly streams the AI's response tokens directly to the UI as they are generated.
- **Odisha Government Aesthetic**: Clean, responsive light theme featuring tricolor accents, Noto Sans typography, and dual-language (English/Odia) support.
- **React + TypeScript + MUI Frontend**: Component-based chat UI built with Vite, typed end-to-end, and styled with Material UI.

---

## Project Structure

```text
Orchevo_Script_Application/
├── backend/
│   ├── main.py                # FastAPI server handling API routes and script execution
│   ├── script.py              # The raw Python snippet downloaded from Paradigm Platform
│   ├── script_transformer.py  # AST parser for injecting inputs/sessions dynamically
│   └── requirements.txt       # Python dependencies
└── frontend/
    ├── index.html             # Vite entry HTML
    ├── src/
    │   ├── main.tsx           # React app bootstrap
    │   ├── App.tsx            # Chat state & orchestration
    │   ├── theme.ts           # MUI theme (gov. saffron/navy palette)
    │   ├── api/chat.ts        # SSE streaming client
    │   ├── utils/markdown.ts  # Markdown → HTML renderer
    │   └── components/        # Header, WelcomeScreen, ChatInput, MessageBubble, ...
    ├── package.json
    └── vite.config.ts
```

---

## Setup & Installation

### Prerequisites
- **Python 3.11+**
- **Node.js 20+**

### 1. Install Backend Dependencies

```bash
cd backend
pip install -r requirements.txt
```

### 2. Install Frontend Dependencies

```bash
cd frontend
npm install
```

### 3. Build the Frontend
The backend serves the compiled frontend from `frontend/dist`, so build it before starting the server (and re-run this after any frontend change):

```bash
cd frontend
npm run build
```

For frontend-only development with hot reload, run `npm run dev` instead (proxies `/api` requests to `http://localhost:8000`).

---

## Running the Application

### Start the Server
Run the FastAPI backend server using Uvicorn. The server is configured to serve both the API endpoints and the built frontend (`frontend/dist`).

```bash
cd backend
python -m uvicorn main:app --host 0.0.0.0 --port 8000
```

### Access the UI
Open your web browser and navigate to:
**[http://localhost:8000](http://localhost:8000)**

---

## Updating the AI Workflow

If you modify your workflow on the Paradigm Platform and want to update this app:
1. Export the new Python snippet from the platform.
2. Replace the contents of `backend/script.py` with your new snippet.
3. Make sure the new `WORKFLOW_KEY` in `script.py` is valid.
4. **No restart required!** The backend reads `script.py` dynamically on every request. Just send a new message in the UI and it will use the new script.
