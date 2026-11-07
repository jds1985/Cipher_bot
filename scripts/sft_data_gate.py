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


STOP = {
    "a", "an", "the", "of", "to", "and", "in", "on", "is", "are", "was", "were", "be",
    "what", "how", "many", "which", "who", "when", "where", "why", "do", "does", "did",
    "this", "that", "these", "those", "into", "only", "just", "for", "with", "from", "by",
    "or", "if", "you", "your", "it", "its", "at", "as", "than", "then", "so", "not", "no",
    "can", "cannot", "know", "say", "have", "has", "about", "there", "all", "every",
    "use", "using", "read", "paragraph", "question", "write", "tell", "short", "clean",
    "explain", "sentence", "sentences", "answer", "reply", "exactly", "nothing", "else",
    "words", "word", "list", "separated", "commas", "translate", "english", "phrase",
    "translation", "should", "receive", "pay", "cost", "costs", "dollar", "dollars",
    "bill", "together", "more", "less",
}


def content_tokens(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9]+", text.lower()) if w not in STOP}


def jaccard(a: set[str], b: set[str]) -> float:
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def frozen_texts(path: Path) -> list[str]:
    doc = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(doc, dict) and isinstance(doc.get("prompts"), list):
        return [p["text"] for p in doc["prompts"] if isinstance(p, dict) and isinstance(p.get("text"), str)]
    if isinstance(doc, dict) and isinstance(doc.get("probes"), list):
        return [p["text"] for p in doc["probes"] if isinstance(p, dict) and isinstance(p.get("text"), str)]
    if isinstance(doc, list):
        out = []
        for row in doc:
            if isinstance(row, dict) and isinstance(row.get("user"), str):
                out.append(row["user"])
            elif isinstance(row, str):
                out.append(row)
        return out
    raise SystemExit(f"{path} is not a prompt list")


def frozen_users(path: Path) -> set[str]:
    return {norm(t) for t in frozen_texts(path)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", type=Path, required=True)
    ap.add_argument("--val", type=Path, required=True)
    ap.add_argument("--frozen", type=Path, action="append", default=[])
    ap.add_argument("--max-assistant-repeat", type=int, default=2)
    ap.add_argument("--lexical-jaccard", type=float, default=0.0)
    ap.add_argument("--ban", action="append", default=[])
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
    frozen_raw = []
    for path in args.frozen:
        frozen_raw.extend(frozen_texts(path))
    lexical_hits = 0
    if args.lexical_jaccard > 0 and frozen_raw:
        frozen_sets = [content_tokens(t) for t in frozen_raw]
        for row in train + val:
            got = content_tokens(row["user"])
            if any(jaccard(got, fr) >= args.lexical_jaccard for fr in frozen_sets):
                lexical_hits += 1
    banned = [b.lower() for b in args.ban]
    ban_hits = 0
    if banned:
        for row in train + val:
            blob = (row["user"] + "\n" + row["assistant"]).lower()
            if any(b in blob for b in banned):
                ban_hits += 1
    print(f"train_rows {len(train)} unique_users {len(tr_user)} unique_assistants {len(tr_asst)}")
    print(f"val_rows {len(val)} unique_users {len(va_user)} unique_assistants {len(va_asst)}")
    print(f"max_assistant_repeat {worst}")
    print(f"train_val_user_overlap {len(user_leak)}")
    print(f"train_val_assistant_overlap {len(asst_leak)}")
    print(f"frozen_prompt_hits {len(hit_frozen)}")
    print(f"lexical_clone_rows {lexical_hits}")
    print(f"banned_phrase_rows {ban_hits}")
    problems = []
    if worst > args.max_assistant_repeat:
        problems.append(f"an assistant string is repeated {worst} times")
    if user_leak:
        problems.append(f"{len(user_leak)} val user strings are also in train")
    if asst_leak:
        problems.append(f"{len(asst_leak)} val assistant strings are also in train")
    if hit_frozen:
        problems.append(f"{len(hit_frozen)} train or val users match a frozen eval prompt")
    if lexical_hits:
        problems.append(f"{lexical_hits} rows are lexical clones of a frozen prompt")
    if ban_hits:
        problems.append(f"{ban_hits} rows contain a banned phrase")
    if problems:
        print("gate_fail " + "; ".join(problems))
        return 2
    print("gate_ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
