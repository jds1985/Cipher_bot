#!/usr/bin/env python3
"""Refuse an SFT jsonl that repeats hotel answers or contains frozen eval prompts.

Does not train, does not read checkpoints, and does not print row text.
Each jsonl row needs string fields user and assistant. split is taken from
the file argument (train or val), not from a row instruction.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path


def norm(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip().lower())


def load_rows(path: Path) -> list[dict]:
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        if not isinstance(row.get("user"), str) or not isinstance(row.get("assistant"), str):
            raise SystemExit(f"{path} row is missing user/assistant strings")
        rows.append(row)
    return rows


def frozen_users(path: Path) -> set[str]:
    doc = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(doc, dict) and isinstance(doc.get("prompts"), list):
        return {norm(p["text"]) for p in doc["prompts"] if isinstance(p, dict) and isinstance(p.get("text"), str)}
    if isinstance(doc, list):
        out = set()
        for row in doc:
            if isinstance(row, dict) and isinstance(row.get("user"), str):
                out.add(norm(row["user"]))
            elif isinstance(row, str):
                out.add(norm(row))
        return out
    raise SystemExit(f"{path} is not a prompt list")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", type=Path, required=True)
    ap.add_argument("--val", type=Path, required=True)
    ap.add_argument("--frozen", type=Path, action="append", default=[])
    ap.add_argument("--max-assistant-repeat", type=int, default=2)
    args = ap.parse_args()
    train, val = load_rows(args.train), load_rows(args.val)
    tr_user, va_user = {norm(r["user"]) for r in train}, {norm(r["user"]) for r in val}
    tr_asst, va_asst = {norm(r["assistant"]) for r in train}, {norm(r["assistant"]) for r in val}
    repeats = Counter(norm(r["assistant"]) for r in train)
    worst = max(repeats.values()) if repeats else 0
    user_leak = tr_user & va_user
    asst_leak = tr_asst & va_asst
    frozen = set()
    for path in args.frozen:
        frozen |= frozen_users(path)
    hit_frozen = sorted(u for u in (tr_user | va_user) if u in frozen)
    print(f"train_rows {len(train)} unique_users {len(tr_user)} unique_assistants {len(tr_asst)}")
    print(f"val_rows {len(val)} unique_users {len(va_user)} unique_assistants {len(va_asst)}")
    print(f"max_assistant_repeat {worst}")
    print(f"train_val_user_overlap {len(user_leak)}")
    print(f"train_val_assistant_overlap {len(asst_leak)}")
    print(f"frozen_prompt_hits {len(hit_frozen)}")
    problems = []
    if worst > args.max_assistant_repeat:
        problems.append(f"an assistant string is repeated {worst} times")
    if user_leak:
        problems.append(f"{len(user_leak)} val user strings are also in train")
    if asst_leak:
        problems.append(f"{len(asst_leak)} val assistant strings are also in train")
    if hit_frozen:
        problems.append(f"{len(hit_frozen)} train or val users match a frozen eval prompt")
    if problems:
        print("gate_fail " + "; ".join(problems))
        return 2
    print("gate_ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
