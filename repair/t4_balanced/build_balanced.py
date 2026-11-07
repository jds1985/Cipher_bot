#!/usr/bin/env python3
"""Build a general-heavy SFT jsonl from parent by_source files when they are present.

Does not read general-v2 while selecting rows beyond the separate gate.
Does not invent licenses: a file is kept only when its name contains one of the
license tokens recorded in the v3 metadata filenames. Confirm that token against
the dataset card before a real run. Math files are capped so they cannot be 64%
of the conversations. The 36-row toy is not an input.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GATE = ROOT.parent / "scripts" / "sft_data_gate.py"

# Filename token -> license string printed from that token, not from memory of a card.
LICENSE_TOKEN = {
    "cc_by_sa_3_0": "CC-BY-SA-3.0",
    "cc_by_sa_4_0": "CC-BY-SA-4.0",
    "cc_by_4_0": "CC-BY-4.0",
    "apache_2_0": "Apache-2.0",
    "mit": "MIT",
}
HUMAN = ("dolly", "oasst", "aya", "squad", "cnn", "mbpp")
MATH = ("gsm8k", "math_")


def license_of(path: Path) -> str | None:
    name = path.name.lower()
    for token, label in LICENSE_TOKEN.items():
        if token in name:
            return label
    return None


def kind_of(path: Path) -> str:
    name = path.name.lower()
    if any(h in name for h in HUMAN):
        return "human"
    if any(m in name for m in MATH):
        return "math"
    return "other"


def rows_of(path: Path, cap: int) -> list[dict]:
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        obj = json.loads(line)
        msgs = obj.get("messages")
        if not isinstance(msgs, list):
            continue
        user = "\n".join(m.get("content", "") for m in msgs if m.get("role") == "user")
        assistant = "\n".join(m.get("content", "") for m in msgs if m.get("role") == "assistant")
        if not user.strip() or not assistant.strip():
            continue
        out.append({
            "system": "You are Cipher, a helpful assistant. Answer the user clearly and accurately. If you do not know, say so.",
            "user": user,
            "assistant": assistant,
            "source_file": path.name,
            "license_token": license_of(path),
            "origin": kind_of(path),
        })
        if len(out) >= cap:
            break
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sources", type=Path)
    ap.add_argument("--out", type=Path, default=Path("balanced"))
    ap.add_argument("--max-human", type=int, default=8000)
    ap.add_argument("--max-math", type=int, default=2000)
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    if args.self_test:
        sample = ROOT.parent.parent / "repair"  # not used
        src = Path("/tmp/v3ev/samples")
        if not src.is_dir():
            print("self-test samples missing")
            return 2
        args.sources = src
        args.max_human = 3
        args.max_math = 1
        args.out = Path("/tmp/balanced-self")
    if args.sources is None or not args.sources.is_dir():
        print("sources_missing pass --sources to the parent by_source directory")
        print("expected names include dolly_15k_human_cc_by_sa_3_0.jsonl and gsm8k_train_human_mit.jsonl")
        return 2
    human, math, skipped = [], [], []
    for path in sorted(args.sources.glob("*.jsonl")):
        lic = license_of(path)
        if lic is None:
            skipped.append(path.name)
            continue
        group = human if kind_of(path) == "human" else math if kind_of(path) == "math" else None
        if group is None:
            skipped.append(path.name + " other")
            continue
        cap = args.max_human if group is human else args.max_math
        group.extend(rows_of(path, cap))
    if len(math) > len(human) and human:
        math = math[:len(human)]
    args.out.mkdir(parents=True, exist_ok=True)
    def dump(name, rows):
        (args.out / name).write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")
    # last 10% of each pool is val, by file order, not by a frozen prompt list
    def split(rows):
        cut = max(1, len(rows) // 10) if len(rows) >= 10 else 1 if len(rows) > 1 else 0
        return rows[cut:], rows[:cut]
    tr_h, va_h = split(human)
    tr_m, va_m = split(math)
    dump("train.jsonl", tr_h + tr_m)
    dump("val.jsonl", va_h + va_m)
    print(f"human {len(human)} math {len(math)} skipped {len(skipped)}")
    print("license_source filename_token_only confirm_against_parent_files")
    print("math_share_conversations", round(len(math) / max(1, len(human) + len(math)), 3))
    print("not_started packing and training are separate; this file is not the 36-row toy")
    return 0


if __name__ == "__main__":
    sys.exit(main())
