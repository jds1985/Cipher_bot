#!/usr/bin/env python3
"""Greedy FP32 baseline of the frozen general-v2 prompts.

Run this before training and keep the jsonl. Training selection does not
import this file. Weights must be the logged SFTv3 checkpoint.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
EXPECTED = "7c1b337f5e4a0e0b4636201682974b24c69682932dfedefce48bf180500d77e9"
HELD = "3c15169dfd848b57209b71813f75f972c74c35a0ce745c803376db33cb1323f9"


def fp32_argv(pt: str, ids: str, out: str, tokenizer: str, ctx: int, limit: int = 28) -> list[str]:
    return [
        sys.executable, str(HERE / "eval" / "fp32_greedy.py"),
        "--pt", pt, "--ids", ids, "--out", out, "--tokenizer", tokenizer,
        "--rep", "1", "--limit", str(limit), "--ctx", str(ctx), "--max-new", "128",
    ]


def main() -> int:
    held_path = HERE / "fixtures" / "general-v2.json"
    digest = hashlib.sha256(held_path.read_bytes()).hexdigest()
    if digest != HELD:
        print("heldout_changed")
        return 2
    if len(sys.argv) < 3:
        print("usage: baseline_v2.py --pt sft_model.pt --out baseline-v2.jsonl")
        return 2
    # Delegate to the general-v1 id builder's sibling by constructing a temporary
    # prompt file is unnecessary: fp32_greedy reads an ids tsv. Build it here.
    sys.path.insert(0, str(HERE))
    from tokenizers import Tokenizer
    pack = json.loads(held_path.read_text(encoding="utf-8"))
    tok_arg = None
    pt = None
    out = None
    ctx = 512
    argv = sys.argv[1:]
    i = 0
    while i < len(argv):
        if argv[i] == "--pt":
            pt = argv[i + 1]
            i += 2
        elif argv[i] == "--out":
            out = argv[i + 1]
            i += 2
        elif argv[i] == "--tokenizer":
            tok_arg = argv[i + 1]
            i += 2
        elif argv[i] == "--ctx":
            ctx = int(argv[i + 1])
            i += 2
        else:
            print("unknown", argv[i])
            return 2
    if not pt or not out or not tok_arg:
        print("need --pt --tokenizer --out")
        return 2
    if os.environ.get("BASELINE_ARGV_ONLY") == "1":
        print("\n".join(fp32_argv(pt, "IDS", out, tok_arg, ctx)))
        return 0
    tok = Tokenizer.from_file(tok_arg)
    enc = lambda text: tok.encode(text, add_special_tokens=False).ids
    lines = []
    for item in pack["prompts"]:
        ids = [4] + enc(pack["system"].rstrip() + "\n") + [2] + enc(item["text"].rstrip() + "\n") + [3]
        lines.append(item["id"] + "\t" + ",".join(str(n) for n in ids))
    ids_path = Path(out).with_suffix(".ids.tsv")
    ids_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    cmd = fp32_argv(pt, str(ids_path), out, tok_arg, ctx)
    raise SystemExit(subprocess.call(cmd))


if __name__ == "__main__":
    raise SystemExit(main())
