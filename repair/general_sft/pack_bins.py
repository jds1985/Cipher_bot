#!/usr/bin/env python3
"""Pack repair jsonl into the uint16 token rows and uint8 loss masks sft_train reads.

Template matches the runtime contract: system id 4, user id 2, assistant id 3,
end-of-text id 0. Loss is 1 only on assistant text tokens and the final end-of-text.
Does not read the held-out prompt file.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from tokenizers import Tokenizer

EOT, PAD, USER, ASSISTANT, SYSTEM = 0, 1, 2, 3, 4
CTX = 1024


def encode_row(tok: Tokenizer, row: dict) -> tuple[list[int], list[int]]:
    enc = lambda text: tok.encode(text, add_special_tokens=False).ids
    ids = [SYSTEM] + enc(row["system"].rstrip() + "\n")
    ids += [USER] + enc(row["user"].rstrip() + "\n")
    ids += [ASSISTANT]
    body = enc(row["assistant"])
    mask = [0] * len(ids) + [1] * len(body) + [1]
    ids += body + [EOT]
    if len(ids) > CTX:
        raise SystemExit(f"{row.get('id')} is {len(ids)} tokens, over {CTX}")
    pad = CTX - len(ids)
    return ids + [PAD] * pad, mask + [0] * pad


def pack(src: Path, tok: Tokenizer) -> tuple[np.ndarray, np.ndarray]:
    rows = [json.loads(line) for line in src.read_text(encoding="utf-8").splitlines() if line.strip()]
    xs, ms = zip(*(encode_row(tok, row) for row in rows))
    return np.asarray(xs, dtype=np.uint16), np.asarray(ms, dtype=np.uint8)


def main() -> None:
    root = Path(__file__).resolve().parent
    tok_path = root.parents[1] / "native" / "cipher-wasm" / "fixtures" / "tokenizer.json"
    tok = Tokenizer.from_file(str(tok_path))
    data = root / "data"
    for split in ("train", "val"):
        x, m = pack(data / f"{split}.jsonl", tok)
        x.tofile(data / f"{split}_x.bin")
        m.tofile(data / f"{split}_m.bin")
        print(f"{split} {x.shape} masked {int(m.sum())}")
    meta = {
        "ctx": CTX,
        "vocab_size": 32000,
        "n_train": sum(1 for line in (data / "train.jsonl").read_text().splitlines() if line.strip()),
        "n_val": sum(1 for line in (data / "val.jsonl").read_text().splitlines() if line.strip()),
        "dtype": "uint16",
        "mask_dtype": "uint8",
        "eot_id": EOT,
        "pad_id": PAD,
        "role_ids": {"system": SYSTEM, "user": USER, "assistant": ASSISTANT},
        "template": "system id + system text newline, user id + user text newline, assistant id + assistant text + EOT",
        "loss": "assistant text tokens and final EOT only",
        "origin": "synthetic-original",
        "license": "Original synthetic examples written for this repair. No external corpus.",
        "base_sha256": "7c1b337f5e4a0e0b4636201682974b24c69682932dfedefce48bf180500d77e9",
        "base_bytes": 1474893963,
        "heldout": "frozen/general-v2.json sha 3c15169dfd848b57209b71813f75f972c74c35a0ce745c803376db33cb1323f9",
        "not_a_claim": "Packing does not train and does not predict held-out gain.",
    }
    (data / "meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    print("meta", meta["n_train"], meta["n_val"])


if __name__ == "__main__":
    main()
