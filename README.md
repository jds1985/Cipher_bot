# Cipher_bot

**Cipher Bot** is a local-first desktop app for making simple chat bots and talking to them. Every reply comes
from **Cipher**, Jim's own model, which ships inside the app and runs on your computer through the bundled
`cipher-serve` (a small C server around the Cipher ternary runtime). There is no third-party model, no model
download, no cloud server, no account and no telemetry.

- The main process starts `cipher-serve` on launch (127.0.0.1, a free port, a per-launch bearer token),
  health-checks it, restarts it if it crashes (3 tries with backoff) and stops it on quit (SIGTERM, then SIGKILL).
- `cipher-serve` speaks the OpenAI chat-completions API (`POST /v1/chat/completions`, `stream: true` → SSE),
  plus `GET /health` and `GET /v1/models`, using the model's own chat template and tokenizer.
- The model is described by `resources/model/manifest.json` (id, file, sha256, context size, reply cap, sampling,
  capabilities). Swapping models (135M stand-in → 369M Cipher 2.0) = swap the `.ctern` file and the manifest.
- **Public build only.** The manifest must say `"build": "public"`; anything that looks like the private dev build
  is refused by the app and by `scripts/fetch-model.mjs`, so it can never be bundled.

### Small context, honest tools

The current stand-in (135M, int8 ternary) has a **1,024-token** context. History is trimmed by tokens
(nCtx − reply tokens − margin; system prompt first, newest turns next; cipher-serve trims exactly with the real
tokenizer as a backstop). System prompts are short. The 135M cannot do function calling reliably, so its manifest
says `"toolCalling": false`: **no tools are offered** (files, search, calculator, checklist, write) and the Tools
dialog shows them greyed out with a note. Switch choices are kept and come back when a tool-capable model's
manifest sets `toolCalling: true`. See `/workspace/cipher_bot_audit/cipher_runtime/BASELINE.md` for measurements.

## Prerequisites (from source)

- Node.js 22.12+ with npm, a C compiler (`cc`/gcc/clang) and `make`.
- The public Cipher model file. `npm run model` copies it into `resources/model/` and checks size + sha256
  (default source `/workspace/cipher_runtime/sft.ctern`; override with `CIPHER_MODEL_SRC=/path/to/file.ctern`).
- `npm run native` builds `resources/bin/linux-x64/cipher-serve` (electron-builder names: linux-arm64, mac-arm64, ...).

## Run in development

```sh
git clone https://github.com/jds1985/Cipher_bot.git
cd Cipher_bot
npm install      # postinstall builds better-sqlite3 for Electron (needs a C++ toolchain if no prebuild exists)
npm run native   # builds cipher-serve
npm run model    # copies + verifies the public Cipher model
npm run dev      # compiles TypeScript and launches the app
```

If `npm ci` stops with "Could not build better-sqlite3 for Electron", install a C++ toolchain
(`sudo apt install build-essential python3`, `xcode-select --install`, or VS Build Tools on Windows) and run `npm rebuild`.

Chat history sent to the model is limited by tokens to what fits the model's context (see above).

Other scripts:

| Command             | What it does                                                         |
| ------------------- | -------------------------------------------------------------------- |
| `npm run typecheck` | Type-check main, preload and renderer code                           |
| `npm test`          | Unit tests (DB layer, folder sandbox, backend + server lifecycle vs. a fake cipher-serve and the real one) |
| `npm start`         | Launch the last build without recompiling                            |

`better-sqlite3` ships prebuilt binaries for common platforms. If none matches yours, `npm install` compiles
it, which needs a C++ toolchain (Xcode Command Line Tools on macOS, "Desktop development with C++" in Visual
Studio Build Tools on Windows, `build-essential` and `python3` on Linux).

## Build a packaged app

```sh
npm run dist       # installers for the current OS, written to release/
npm run dist:dir   # unpacked app only (quicker, good for a test run)
```

`dist` builds cipher-serve and verifies the model first; both are copied into the package's `resources/`
(`bin/cipher-serve`, `model/manifest.json` + `.ctern`). Build on the OS you are targeting: Linux (done first, tested)
gives an AppImage and a .deb; macOS (`make` with clang, `mac-arm64`/`mac-x64`) a .dmg; Windows needs a
MinGW-w64 build of cipher-serve with a Winsock shim (not written yet) and gives an NSIS installer. Builds are unsigned, so macOS Gatekeeper and Windows SmartScreen will warn the first time you open them.

## Where your data lives

The database is `cipher.db` in the OS app-data folder:

- Linux: `~/.config/Cipher/cipher.db`
- macOS: `~/Library/Application Support/Cipher/cipher.db`
- Windows: `%APPDATA%\Cipher\cipher.db`

Delete that file to start fresh. The model lives inside the app package (`resources/model/`).
