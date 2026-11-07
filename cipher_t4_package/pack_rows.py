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


def encode_row(tok: Tokenizer, row: dict) -> tuple[list[int], list[int]]:
    enc = lambda text: tok.encode(text, add_special_tokens=False).ids
    system = row.get("system") or "You are Cipher, a helpful assistant. Answer the user clearly and accurately. If you do not know, say so."
    ids = [SYSTEM] + enc(system.rstrip() + "\n") + [USER] + enc(row["user"].rstrip() + "\n") + [ASSISTANT]
    body = enc(row["assistant"])
    mask = [0] * len(ids) + [1] * len(body) + [1]
    ids = ids + body + [EOT]
    if len(ids) > CTX:
        ids, mask = ids[:CTX], mask[:CTX]
    else:
        pad = CTX - len(ids)
        ids, mask = ids + [PAD] * pad, mask + [0] * pad
    return ids, mask


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=Path, required=True)
    ap.add_argument("--tokenizer", type=Path, required=True)
    args = ap.parse_args()
    tok = Tokenizer.from_file(str(args.tokenizer))
    for split in ("train", "val"):
        rows = [json.loads(line) for line in (args.data / f"{split}.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
        xs, ms = zip(*(encode_row(tok, row) for row in rows))
        np.asarray(xs, dtype=np.uint16).tofile(args.data / f"{split}_x.bin")
        np.asarray(ms, dtype=np.uint8).tofile(args.data / f"{split}_m.bin")
        print(split, len(rows), "masked", int(np.asarray(ms).sum()))
    meta = {"ctx": CTX, "vocab_size": 32000, "n_train": None, "n_val": None, "origin": "catalogued sources, licenses not merged"}
    meta["n_train"] = sum(1 for line in (args.data / "train.jsonl").read_text().splitlines() if line.strip())
    meta["n_val"] = sum(1 for line in (args.data / "val.jsonl").read_text().splitlines() if line.strip())
    (args.data / "meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
