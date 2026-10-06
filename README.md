# Cipher_bot

**Cipher** is a local-first desktop app for making simple chat bots and talking to them with a model that
runs on your own computer through [Ollama](https://ollama.com). There is no cloud server, no account, no
telemetry and no auto-updater. The only network connection the app makes is to Ollama on
`http://127.0.0.1:11434` (localhost).

v1 features:

- Create a bot with a name, a system prompt and a tools on/off switch.
- Chat with it; replies stream in as they are generated (Stop button to cancel).
- One tool, `read_file`: the bot can read UTF-8 text files (up to 256 KB) inside one folder you pick with the
  native folder dialog. Paths are resolved (including `..` and symlinks) and anything outside that folder is refused.
- Bots, chats and messages are saved in a local SQLite database and restored when you reopen the app.
- Works fully offline once the model is downloaded.

See [PLAN.md](PLAN.md) for the design and what is out of scope.

## Prerequisites

- **Node.js 22.12 or newer** (22 LTS recommended) with npm. Only needed to run from source or build.
- **Ollama**: install from https://ollama.com/download and make sure it is running
  (the desktop app starts it automatically; on Linux you can also run `ollama serve`).
- **The default model** (about 4.7 GB, Q4-quantized by default in Ollama). Download it once:

  ```sh
  ollama pull qwen2.5:7b
  ```

  The app never downloads or bundles a model. If Ollama isn't running or the model is missing, Cipher shows
  a banner with the exact command to fix it.

To use another tool-capable model you already have (for example `llama3.1:8b`), set `CIPHER_MODEL`:

```sh
CIPHER_MODEL=llama3.1:8b npm run dev          # macOS / Linux
$env:CIPHER_MODEL="llama3.1:8b"; npm run dev  # Windows PowerShell
```

## Run in development

```sh
git clone https://github.com/jds1985/Cipher_bot.git
cd Cipher_bot
npm install      # also fetches the Electron build of better-sqlite3
npm run dev      # compiles TypeScript and launches the app
```

Other scripts:

| Command             | What it does                                                         |
| ------------------- | -------------------------------------------------------------------- |
| `npm run typecheck` | Type-check main, preload and renderer code                           |
| `npm test`          | Unit tests (DB layer, folder sandbox, tool-calling loop vs. a fake Ollama) |
| `npm start`         | Launch the last build without recompiling                            |

`better-sqlite3` ships prebuilt binaries for common platforms. If none matches yours, `npm install` compiles
it, which needs a C++ toolchain (Xcode Command Line Tools on macOS, "Desktop development with C++" in Visual
Studio Build Tools on Windows, `build-essential` and `python3` on Linux).

## Build a packaged app

```sh
npm run dist       # installers for the current OS, written to release/
npm run dist:dir   # unpacked app only (quicker, good for a test run)
```

Build on the OS you are targeting: Linux gives an AppImage and a .deb, macOS a .dmg, Windows an NSIS
installer. Builds are unsigned, so macOS Gatekeeper and Windows SmartScreen will warn the first time you open them.

## Where your data lives

The database is `cipher.db` in the OS app-data folder:

- Linux: `~/.config/Cipher/cipher.db`
- macOS: `~/Library/Application Support/Cipher/cipher.db`
- Windows: `%APPDATA%\Cipher\cipher.db`

Delete that file to start fresh. Models live in Ollama's own storage, not in the app.
