#!/usr/bin/env python3
"""Refuse an SFT jsonl that repeats hotel answers or contains frozen eval prompts.

Does not train, does not read checkpoints, and does not print row text.
Each jsonl row needs string fields user and assistant. split is taken from
the file argument (train or val), not from a row instruction.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

from mix_rules import (
    PER_TEMPLATE_CAP,
    SHORT_ANSWER_CAP,
    assistant_audit,
    clone_match,
    load_frozen,
    norm,
)


def load_rows(path: Path) -> list[dict]:
    rows = []
    text = path.read_bytes().decode("utf-8")
    if text.startswith("\ufeff"):
        text = text[1:]
    for line in text.split("\n"):
        if line.endswith("\r"):
            line = line[:-1]
        if not line.strip():
            continue
        row = json.loads(line)
        if not isinstance(row.get("user"), str) or not isinstance(row.get("assistant"), str):
            raise SystemExit(f"{path} row is missing user/assistant strings")
        rows.append(row)
    return rows


def frozen_users(paths: list[Path]) -> set[str]:
    return {entry["norm"] for entry in load_frozen(paths)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", type=Path, required=True)
    ap.add_argument("--val", type=Path, required=True)
    ap.add_argument("--frozen", type=Path, action="append", default=[])
    ap.add_argument("--max-assistant-repeat", type=int, default=1)
    ap.add_argument("--lexical-jaccard", type=float, default=0.0)
    ap.add_argument("--ban", action="append", default=[])
    args = ap.parse_args()
    train, val = load_rows(args.train), load_rows(args.val)
    tr_user, va_user = {norm(r["user"]) for r in train}, {norm(r["user"]) for r in val}
    user_leak = tr_user & va_user
    frozen_norm = frozen_users(args.frozen) if args.frozen else set()
    hit_frozen = sorted(u for u in (tr_user | va_user) if u in frozen_norm)
    lexical = []
    if args.lexical_jaccard > 0 and args.frozen:
        frozen_entries = load_frozen(args.frozen)
        if args.lexical_jaccard != 0.5:
            raise SystemExit("lexical threshold is fixed at 0.5 in the shared predicate")
        for row in train + val:
            hit = clone_match(row["user"], frozen_entries)
            if hit:
                lexical.append({
                    "kind": "lexical_clone",
                    "source_file": row.get("source_file"),
                    "source_line": row.get("source_line"),
                    **hit,
                })
    audit, answer_problems = assistant_audit(train, val, args.max_assistant_repeat)
    repeats = Counter(norm(r["assistant"]) for r in train)
    worst = max(repeats.values()) if repeats else 0
    banned = [b.lower() for b in args.ban]
    ban_hits = 0
    if banned:
        for row in train + val:
            blob = (row["user"] + "\n" + row["assistant"]).lower()
            if any(b in blob for b in banned):
                ban_hits += 1
    print(f"train_rows {len(train)} unique_users {len(tr_user)} unique_assistants {audit['unique_train']}")
    print(f"val_rows {len(val)} unique_users {len(va_user)} unique_assistants {audit['unique_val']}")
    print(f"max_assistant_repeat {worst}")
    print(f"train_val_user_overlap {len(user_leak)}")
    print(f"train_val_assistant_overlap {audit['unique_shared']}")
    print(f"shared_answer_rows_train {audit['shared_rows_train']}")
    print(f"shared_answer_rows_val {audit['shared_rows_val']}")
    print(f"frozen_prompt_hits {len(hit_frozen)}")
    print(f"lexical_clone_rows {len(lexical)}")
    print(f"banned_phrase_rows {ban_hits}")
    print("assistant_audit " + json.dumps(audit, ensure_ascii=False))
    for hit in lexical:
        print("lexical_clone " + json.dumps(hit, ensure_ascii=False))
    problems = []
    problems.extend(answer_problems)
    if user_leak:
        problems.append(f"{len(user_leak)} val user strings are also in train")
    if hit_frozen:
        problems.append(f"{len(hit_frozen)} train or val users match a frozen eval prompt")
    if lexical:
        problems.append(f"{len(lexical)} rows are lexical clones of a frozen prompt")
    if ban_hits:
        problems.append(f"{ban_hits} rows contain a banned phrase")
    if problems:
        print("gate_fail " + "; ".join(problems))
        return 2
    print("gate_ok")
    print(
        f"answer_caps template {PER_TEMPLATE_CAP} short {SHORT_ANSWER_CAP} "
        f"substantial {args.max_assistant_repeat}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
