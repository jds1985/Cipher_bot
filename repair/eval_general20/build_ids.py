#!/usr/bin/env python3
"""Write the already-scored general-v1 chat prompts as token-id lines.

Does not open the held-out prompt file.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from tokenizers import Tokenizer

ROOT = Path(__file__).resolve().parents[1]
PROMPTS = ROOT.parent / "native" / "cipher-wasm" / "fixtures" / "general-v1.json"
TOK = ROOT.parent / "native" / "cipher-wasm" / "fixtures" / "tokenizer.json"
SYSTEM_ID, USER_ID, ASSISTANT_ID = 4, 2, 3


def prompt_ids(tok: Tokenizer, system: str, user: str) -> list[int]:
    enc = lambda text: tok.encode(text, add_special_tokens=False).ids
    return [SYSTEM_ID] + enc(system.rstrip() + "\n") + [USER_ID] + enc(user.rstrip() + "\n") + [ASSISTANT_ID]


def main() -> int:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "general-v1-ids.tsv")
    pack = json.loads(PROMPTS.read_text(encoding="utf-8"))
    tok = Tokenizer.from_file(str(TOK))
    lines = []
    for item in pack["prompts"]:
        ids = prompt_ids(tok, pack["system"], item["text"])
        lines.append(item["id"] + "\t" + ",".join(str(i) for i in ids))
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {len(lines)} prompts to {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
