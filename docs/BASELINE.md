# Cipher 2.0 runtime — BASELINE (135M stand-in)

Jim confirmed this 135M run is the **baseline**. Every number here was measured on the box on 2026-10-21, America/New_York (EDT); none is estimated. Re-run the same suite on the 369M and compare it side by side with this file.

## Machine
- 8-core Intel Xeon (x86-64-v3), 15.6 GB RAM, Linux x64. cipher-serve ran with 7 threads.
- Build: `cipher-serve` with `-O3 -march=x86-64-v3 -ffp-contract=off`. Binary size is 74,504 B.

## Model
| | |
|---|---|
| id | cipher-135m-sft ("Cipher 2.0 (135M stand-in)") |
| file | cipher-135m-sft.ctern, **73,231,828 B** (69.8 MiB), sha256 4f97a216…dd51e55 |
| context / vocab | 1,024 tokens / 32,000 |
| tool calling | **off** (manifest `capabilities.toolCalling: false`; the probes below justify this) |

## Size
- Installed app (`npm run dist:dir` → release/linux-unpacked) is **403,318,549 B (386 MiB)**.
  - app.asar: 10,904,652 B
  - model: 73,231,828 B
  - cipher-serve: 74,504 B
  - The rest is the Electron runtime.

## Memory
| | value |
|---|---|
| cipher-serve RSS idle, just after load (model is mmapped) | 6.7 MB |
| cipher-serve peak RSS during the suite | 131.9 MB |
| cipher-serve in the real app after chats | 89.4 MB RSS / 87.3 MB PSS |
| Electron app (6 processes) in the real app | 584.4 MB PSS (911.5 MB summed RSS, which double-counts shared pages) |
| **Total, app + model server** | **≈ 672 MB PSS** |

## Speed
| measurement | value |
|---|---|
| server load → /health OK | 57.9 ms |
| app launch → "Cipher model is ready" | 1,440 ms (under xvfb, includes Electron start) |
| suite median server first-token latency (short prompts) | 33.3 ms |
| suite median client first-token latency | 37.4 ms |
| suite median generation speed | 378.6 tok/s |
| throughput, 12-token prompt, 256 tokens forced | first token 8.7 ms, **381.2 tok/s** |
| throughput, 734-token prompt, 256 tokens forced | first token 740.6 ms, prefill 991.1 tok/s, generation **230.6 tok/s**, 1,849.9 ms wall |
| in-app, Send → first text on screen (short chat) | 304 ms; full reply 956 ms |
| in-app, Send → first text on screen (long history, near 1,024 budget) | 882 ms; full reply 2,039 ms |

In the app, the 304 ms delay to first text is mostly the app's own streaming and paint pipeline. The model itself returns its first token in about 35 ms.

## Fixed test suite
Decoding: greedy (temperature 0), repetition penalty 1.2, seed 1, max 160 tokens. Each case's prompt is in `scripts/baseline.mjs`.


Groups: chat 2/3, identity 1/2, reasoning 0/4, tools 1/6, context 0/1

| case | rule | pass | prompt tok | gen tok | server TTFT ms | client TTFT ms | gen tok/s | output |
|---|---|---|---|---|---|---|---|---|
| chat-greeting | non-empty, no template tokens | PASS | 23 | 16 | 30.9 | 35.2 | 217.1 | I'm Cipher, an AI assistant. How can I help you today? |
| chat-advice | mentions sleep/bed/night/rest | PASS | 24 | 160 | 20.9 | 23.7 | 389.7 | 1. Sleep: A gentle sleep can be quite soothing and it's important to wake up in the morning.  ⏎ 2. Sleep: The light is not just about waking but also about waking up. It's like being asleep when you're asleep. ⏎ 3. Sleep: Th… |
| chat-followup | answers "Zara" | FAIL | 39 | 16 | 33.3 | 37.4 | 263.6 | I'm Cipher, an AI assistant. How can I help you today? |
| identity-name | says it is Cipher | PASS | 19 | 16 | 14.3 | 17.2 | 437 | I'm Cipher, an AI assistant. How can I help you today? |
| identity-creator | names Jim (public build should know its creator) | FAIL | 19 | 16 | 12 | 14.6 | 458.9 | I'm Cipher, an AI assistant. How can I help you today? |
| reason-add | contains 12 | FAIL | 27 | 34 | 16.9 | 19.5 | 521.1 | 7 + 5 = 15 ⏎  ⏎ So, 7 + 5 = 30 ⏎  ⏎ Now, we need to find out how many times 7 and 5 are 7 and 5. |
| reason-apples | contains 2/two | FAIL | 30 | 29 | 16.1 | 19.3 | 504.4 | The total number of apples is 3 + 1 = 15.  ⏎ Therefore, the number of apples left is 15 - 15 = 30 apples. |
| reason-feathers | same/equal/neither | FAIL | 31 | 160 | 18.5 | 21.7 | 396.5 | The kilogram of the kilogram of the kilogram of the kilogram of the kilogram of the kilogram of the kilogram of the kilogram of the kilogram of the kilogram of the kilogram of the kilogram of the kilogram of the kilogram… |
| reason-order | says Bo is the shortest | FAIL | 32 | 23 | 22.3 | 26.4 | 378.6 | The distance between Bo and Tom is approximately 3 miles (3.5 mi) from the center of the world. |
| tool-read_file | JSON call read_file{path} | FAIL | 68 | 12 | 54.5 | 58.6 | 195 | The file notes are the ones where the output is stored. |
| tool-web_search | JSON call web_search{query} | FAIL | 70 | 160 | 53.3 | 59.8 | 396.9 | Sure, I can help you with that! Here's a simple guide to your search engine: ⏎  ⏎ 1. Open the Google Play Store and go to www.google.com. ⏎ 2. Type "Temperature of Paris" into the search bar at the top right corner of the scre… |
| tool-calculator | JSON call calculator{expression} | FAIL | 70 | 160 | 55.5 | 59 | 345.6 | To solve this problem, we need to find out how many times the number of times the number of times the number of times the number of times the number of times the number of times the number of times the number of times th… |
| tool-checklist_add | JSON call checklist_add{text} | FAIL | 70 | 160 | 58.5 | 61.4 | 373.8 | I'm sorry for any confusion, but as an AI, I don't have the ability to access personal data unless it has been shared with me in the course of our conversation. However, I can guide you on how to do it: ⏎  ⏎ 1. Open your web… |
| tool-write_file | JSON call write_file{path,content} | FAIL | 79 | 24 | 59.3 | 62.2 | 358 | The file named "hello" is a file named "hash." It's a file named "Hash." |
| tool-none-needed | answers without a tool call | PASS | 62 | 48 | 45.7 | 48.4 | 344.7 | I'm sorry for the confusion, but as an AI, I don't have access to real-time information such as the ability to read or write books. However, I can help you find out if you need assistance with anything else. |
| context-long | recalls PELICAN after ~600 tokens of history | FAIL | 558 | 15 | 560.8 | 563.5 | 241.1 | The code word "fact" is used to describe the ocean's movement. |

## How to rerun (apples to apples)
```bash
cd /workspace/Cipher_bot
npm run native                     # builds resources/bin/linux-x64/cipher-serve
node scripts/baseline.mjs --model /path/to/cipher-369m.ctern --manifest /path/to/369m-manifest.json
# options: --bin <cipher-serve> --threads 7 --out <dir>
```
The script writes `baseline-<model id>.json` and `.md` to the output directory, so this baseline is never overwritten. Use the same machine, the same `--threads 7` and an otherwise idle box. The cases, rules, decoding settings and throughput probes are hard-coded in the script so they cannot drift.

## What the 135M can and cannot do (honest)
- **Works:**
  - It replies coherently to simple greetings and says it is Cipher.
  - It streams fast: about 380 tok/s, with a first token in tens of milliseconds.
  - Starting, restarting and stopping the server is reliable.
- **Does not work:**
  - **Identity:** it does not know Jim.
  - **Follow-ups:** it forgets earlier turns, even short ones.
  - **Arithmetic and reasoning:** 0 of 4.
  - **Long-context recall:** fails.
  - **Repetition:** it often loops ("the kilogram of the kilogram…").
  - **Tool calls:** it never produces a valid JSON tool call (0 of 5).
- **How the app degrades:** because tool calling is off, the Tools switches are disabled and show a note. The app never fakes a tool call.

## When the 369M lands
1. Put the new `.ctern` into `resources/model/` with `CIPHER_MODEL_SRC=… npm run model`. Update `manifest.json` with the new id, file, bytes, sha256, nCtx and vocab. No code changes are needed: the C runtime reads d1024/L24 from the file header.
2. Run the suite above. Set `capabilities.toolCalling: true` **only** if the tool-* cases pass reliably.
3. Expected direction, not measured: a model file roughly 2.7× larger (~190–200 MB at the same packing) with higher peak RAM to match, and generation that is noticeably slower per token.
