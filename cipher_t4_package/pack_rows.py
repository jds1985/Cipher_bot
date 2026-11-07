#!/usr/bin/env python3
"""Pack train.jsonl and val.jsonl to the uint16 rows the trainer reads.

Tokenizer path is an argument. It is the one file allowed to live outside this
package, along with the checkpoint and the raw source jsonl.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from tokenizers import Tokenizer

EOT, PAD, USER, ASSISTANT, SYSTEM = 0, 1, 2, 3, 4
CTX = 1024


def pack_row(encode, row: dict, ctx: int = CTX) -> dict:
    """Pack one row. A prompt that does not leave a target token is rejected.

    Answer tokens that do not fit are dropped from the end and counted.
    The end-of-turn token is kept when one slot remains. The prompt prefix
    is never sliced off to make room.
    """
    system = row.get("system") or "You are Cipher, a helpful assistant. Answer the user clearly and accurately. If you do not know, say so."
    prefix = [SYSTEM] + encode(system.rstrip() + "\n") + [USER] + encode(row["user"].rstrip() + "\n") + [ASSISTANT]
    body = encode(row["assistant"])
    if len(prefix) >= ctx:
        return {
            "status": "reject",
            "reason": "prompt_exceeds_context",
            "prompt_tokens": len(prefix),
            "ctx": ctx,
            "truncated_tokens": 0,
            "supervised_tokens": 0,
            "ids": [],
            "mask": [],
        }
    room = ctx - len(prefix)
    truncated = 0
    if len(body) + 1 <= room:
        target = body + [EOT]
    elif room == 1:
        target = [EOT]
        truncated = len(body)
    else:
        keep = room - 1
        truncated = len(body) - keep
        target = body[:keep] + [EOT]
    ids = prefix + target
    mask = [0] * len(prefix) + [1] * len(target)
    pad = ctx - len(ids)
    ids = ids + [PAD] * pad
    mask = mask + [0] * pad
    return {
        "status": "ok",
        "reason": "truncated_answer" if truncated else "fit",
        "prompt_tokens": len(prefix),
        "ctx": ctx,
        "truncated_tokens": truncated,
        "supervised_tokens": len(target),
        "ids": ids,
        "mask": mask,
    }


def encode_row(tok: Tokenizer, row: dict, ctx: int = CTX) -> dict:
    def encode(text: str) -> list[int]:
        return tok.encode(text, add_special_tokens=False).ids
    return pack_row(encode, row, ctx)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=Path, required=True)
    ap.add_argument("--tokenizer", type=Path, required=True)
    args = ap.parse_args()
    tok = Tokenizer.from_file(str(args.tokenizer))
    report: dict = {"ctx": CTX, "note": "Training pack context is the model max length 1024. Generation comparisons use 512 and are a separate condition."}
    for split in ("train", "val"):
        text = (args.data / f"{split}.jsonl").read_bytes().decode("utf-8")
        rows = []
        for line in text.split("\n"):
            if line.endswith("\r"):
                line = line[:-1]
            if line.strip():
                rows.append(json.loads(line))
        packed = [encode_row(tok, row) for row in rows]
        rejected = [row for row, item in zip(rows, packed) if item["status"] != "ok"]
        kept_pack = [item for item in packed if item["status"] == "ok"]
        if not kept_pack:
            print(split, "no_rows_fit_context")
            return 2
        xs = [item["ids"] for item in kept_pack]
        ms = [item["mask"] for item in kept_pack]
        np.asarray(xs, dtype=np.uint16).tofile(args.data / f"{split}_x.bin")
        np.asarray(ms, dtype=np.uint8).tofile(args.data / f"{split}_m.bin")
        report[split] = {
            "rows": len(rows),
            "packed": len(kept_pack),
            "rejected_prompt_exceeds_context": len(rejected),
            "truncated_answer_rows": sum(1 for item in kept_pack if item["truncated_tokens"]),
            "truncated_tokens": sum(item["truncated_tokens"] for item in kept_pack),
            "rejected_source_lines": [row.get("source_line") for row in rejected],
        }
        print(split, report[split]["packed"], "rejected", report[split]["rejected_prompt_exceeds_context"],
              "truncated_rows", report[split]["truncated_answer_rows"])
    meta = {"ctx": CTX, "vocab_size": 32000, "n_train": None, "n_val": None, "origin": "catalogued sources, licenses not merged"}
    def count(path: Path) -> int:
        n = 0
        for line in path.read_bytes().decode("utf-8").split("\n"):
            if line.strip():
                n += 1
        return n
    meta["n_train"] = count(args.data / "train.jsonl")
    meta["n_val"] = count(args.data / "val.jsonl")
    meta["pack"] = report
    (args.data / "meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    (args.data / "pack_report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
