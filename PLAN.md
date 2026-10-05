# Cipher v1 — Plan

## Goal
A local-first desktop app to create simple chat bots and talk to them using a model running on the
user's own computer. No cloud VM, no backend server, no telemetry, no auto-updater.

## Stack
Electron + TypeScript (vanilla DOM renderer) + better-sqlite3, talking to local Ollama at http://127.0.0.1:11434.
Why not Tauri: this build box lacks webkit2gtk/gtk dev libs and a C toolchain, so Electron is the no-fight option that builds and runs here (and on macOS/Windows) as-is.

## Data model (SQLite file `cipher.db` in the OS app-data dir, `app.getPath('userData')`)
- `bots(id, name, system_prompt, tools_enabled, folder_path, created_at)`
- `chats(id, bot_id → bots, title, created_at, updated_at)`
- `messages(id, chat_id → chats, role [user|assistant|tool], content, tool_calls JSON, tool_name, created_at)`

## Architecture
- Main process owns everything privileged: SQLite, Ollama HTTP (Node fetch, localhost only), the read_file tool, native folder dialog.
- Renderer is sandboxed (contextIsolation, no nodeIntegration, strict CSP, all non-local requests blocked); talks to main via a small preload IPC API.
- Chat loop: POST /api/chat (stream) → stream tokens to UI → if the model returns `tool_calls` and the bot has tools on,
  run `read_file` locally, append a `tool` message, call the model again (max 5 tool rounds).
- `read_file` sandbox: realpath the root and target (resolves symlinks and `..`), reject anything outside the root, files only, ≤256 KB, UTF-8 text only (no NUL bytes).
- Model: default `qwen2.5:7b` (Q4 by default in Ollama), overridable with env `CIPHER_MODEL`. Never bundled. Clear banner if Ollama is down or the model is missing, with the exact `ollama pull` command.

## v1 checklist
- [x] Create a bot: name, system prompt, tools on/off (+ folder picked via native dialog)
- [x] Chat with a bot, streaming responses
- [x] Works fully offline once the model is on disk
- [x] One tool: `read_file` inside the user-picked folder, sandboxed
- [x] Bots, chats, messages persisted locally and restored on relaunch
- [x] Unit tests: DB layer, path sandbox, tool loop against a fake Ollama

## Out of scope (v1)
Cloud sync/accounts, any backend, bundled models or in-app model download, llama.cpp embedding, more tools
(write files, shell, web, email/send actions, browser login), RAG/embeddings, multi-model settings UI,
markdown rendering, plugins, auto-update, telemetry, mobile.
