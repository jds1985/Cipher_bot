# Cipher v1 — Plan

## Goal
A local-first desktop app to create simple chat bots and talk to them using a model running on the
user's own computer. No cloud VM, no backend server, no telemetry, no auto-updater.

## Stack
Electron + TypeScript (vanilla DOM renderer) + better-sqlite3, talking to the bundled cipher-serve (Jim's Cipher model) on 127.0.0.1 (Phase 3: Ollama removed).
Why not Tauri: this build box lacks webkit2gtk/gtk dev libs and a C toolchain, so Electron is the no-fight option that builds and runs here (and on macOS/Windows) as-is.

## Data model (SQLite file `cipher.db` in the OS app-data dir, `app.getPath('userData')`)
- `bots(id, name, system_prompt, tools_enabled, folder_path, created_at)`
- `chats(id, bot_id → bots, title, created_at, updated_at)`
- `messages(id, chat_id → chats, role [user|assistant|tool], content, tool_calls JSON, tool_name, created_at)`

## Architecture
- Main process owns everything privileged: SQLite, the model server (child process, Node fetch to 127.0.0.1 only), the read_file tool, native folder dialog.
- Renderer is sandboxed (contextIsolation, no nodeIntegration, strict CSP, all non-local requests blocked); talks to main via a small preload IPC API.
- Chat loop: POST /api/chat (stream) → stream tokens to UI → if the model returns `tool_calls` and the bot has tools on,
  run `read_file` locally, append a `tool` message, call the model again (max 5 tool rounds).
- `read_file` sandbox: realpath the root and target (resolves symlinks and `..`), reject anything outside the root, files only, ≤256 KB, UTF-8 text only (no NUL bytes).
- Model: Cipher only (resources/model/manifest.json + .ctern), bundled; public build only. No fallback.

## v1 checklist
- [x] Create a bot: name, system prompt, tools on/off (+ folder picked via native dialog)
- [x] Chat with a bot, streaming responses
- [x] Works fully offline once the model is on disk
- [x] One tool: `read_file` inside the user-picked folder, sandboxed
- [x] Bots, chats, messages persisted locally and restored on relaunch
- [x] Unit tests: DB layer, path sandbox, tool loop against a fake model server

## Out of scope (v1)
Cloud sync/accounts, any backend, third-party models, more tools
(write files, shell, web, email/send actions, browser login), RAG/embeddings, multi-model settings UI,
markdown rendering, plugins, auto-update, telemetry, mobile.
