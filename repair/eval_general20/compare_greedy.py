#!/usr/bin/env python3
"""Compare FP32 and ternary greedy transcripts. Does not train."""

from __future__ import annotations

import json
import sys
from pathlib import Path


def load(path: Path) -> dict:
    rows = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            row = json.loads(line)
            rows[row["id"]] = row
    return rows


def main() -> int:
    if len(sys.argv) == 2 and sys.argv[1] == "--self-test":
        a = {"g01": {"text": "Paris.", "tokens": [1], "stop": 0}}
        same = dict(a)
        diff = {"g01": {"text": "Meadow", "tokens": [2], "stop": 0}}
        assert score(a, same)["same_text"] == 1
        assert score(a, diff)["same_text"] == 0
        print("compare self-test ok")
        return 0
    if len(sys.argv) != 3:
        print("usage: compare_greedy.py fp32.jsonl ctern.jsonl")
        return 2
    left, right = load(Path(sys.argv[1])), load(Path(sys.argv[2]))
    stats = score(left, right)
    print(json.dumps(stats, indent=2))
    print("export_changes_greedy_text", "yes" if stats["same_text"] != stats["n"] else "no")
    return 0


def score(left: dict, right: dict) -> dict:
    ids = sorted(set(left) & set(right))
    same_text = same_tok = 0
    changed = []
    for i in ids:
        if left[i].get("text") == right[i].get("text"):
            same_text += 1
        else:
            changed.append(i)
        if left[i].get("tokens") == right[i].get("tokens"):
            same_tok += 1
    return {"n": len(ids), "same_text": same_text, "same_tokens": same_tok, "changed_ids": changed}


if __name__ == "__main__":
    sys.exit(main())
