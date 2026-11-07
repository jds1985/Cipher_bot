#!/usr/bin/env python3
"""Pack train.jsonl and val.jsonl to the uint16 rows the trainer reads.

Tokenizer path is an argument. It is the one file allowed to live outside this
package, along with the checkpoint and the raw source jsonl.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
from tokenizers import Tokenizer

sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
from plan import planned_steps  # noqa: E402

EOT, PAD, USER, ASSISTANT, SYSTEM = 0, 1, 2, 3, 4
CTX = 1024


def pack_row(encode, row: dict, ctx: int = CTX) -> dict:
    """Pack one row that fits entirely. An overflowing prompt or answer is rejected.

    The bins do not contain a shortened answer followed by end-of-turn.
    """
    system = row.get("system") or "You are Cipher, a helpful assistant. Answer the user clearly and accurately. If you do not know, say so."
    prefix = [SYSTEM] + encode(system.rstrip() + "\n") + [USER] + encode(row["user"].rstrip() + "\n") + [ASSISTANT]
    body = encode(row["assistant"])
    answer_tokens = len(body)
    common = {
        "source_file": row.get("source_file"),
        "source_line": row.get("source_line"),
        "prompt_tokens": len(prefix),
        "answer_tokens": answer_tokens,
        "ctx": ctx,
        "truncated_tokens": 0,
    }
    if len(prefix) >= ctx or len(body) + 1 > ctx - len(prefix):
        reason = "prompt_exceeds_context" if len(prefix) >= ctx else "answer_exceeds_context"
        return {**common, "status": "reject", "reason": reason, "supervised_tokens": 0, "ids": [], "mask": []}
    target = body + [EOT]
    ids = prefix + target
    mask = [0] * len(prefix) + [1] * len(target)
    pad = ctx - len(ids)
    return {
        **common,
        "status": "ok",
        "reason": "fit",
        "supervised_tokens": len(target),
        "ids": ids + [PAD] * pad,
        "mask": mask + [0] * pad,
    }


def encode_row(tok: Tokenizer, row: dict, ctx: int = CTX) -> dict:
    def encode(text: str) -> list[int]:
        return tok.encode(text, add_special_tokens=False).ids
    return pack_row(encode, row, ctx)


def word_encode(text: str) -> list[int]:
    return [10 + (i % 50) for i, _word in enumerate(text.split())]


def file_sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=Path, required=True)
    ap.add_argument("--tokenizer", type=Path)
    ap.add_argument("--word-tokens", action="store_true")
    args = ap.parse_args()
    if args.word_tokens:
        encode = word_encode
        mode, tok_sha = "word_fixture", "word_fixture"
    elif args.tokenizer and args.tokenizer.is_file():
        tok = Tokenizer.from_file(str(args.tokenizer))
        encode = lambda text: tok.encode(text, add_special_tokens=False).ids  # noqa: E731
        mode, tok_sha = "huggingface", file_sha(args.tokenizer)
    else:
        print("tokenizer_required")
        return 2
    quality_path = args.data / "quality.json"
    quality = json.loads(quality_path.read_text(encoding="utf-8")) if quality_path.is_file() else {}
    recorded = (quality.get("reconcile") or {}).get("tokenizer_sha256")
    if recorded and recorded != tok_sha:
        print("tokenizer_mismatch", recorded, tok_sha)
        return 2
    report: dict = {
        "ctx": CTX,
        "tokenizer_mode": mode,
        "tokenizer_sha256": tok_sha,
        "truncated_answer_rows": 0,
        "note": "Training pack context is the model max length 1024. Generation context 512 is a separate condition. Answers that do not fit are dropped, not shortened.",
    }
    for split in ("train", "val"):
        text = (args.data / f"{split}.jsonl").read_bytes().decode("utf-8")
        rows = []
        for line in text.split("\n"):
            if line.endswith("\r"):
                line = line[:-1]
            if line.strip():
                rows.append(json.loads(line))
        packed = [pack_row(encode, row) for row in rows]
        rejected = [item for item in packed if item["status"] != "ok"]
        kept_pack = [item for item in packed if item["status"] == "ok"]
        if any(item["truncated_tokens"] or item["reason"] == "truncated_answer" for item in packed):
            print("answer_truncation_refused")
            return 2
        if not kept_pack:
            print(split, "no_rows_fit_context")
            return 2
        for item in kept_pack:
            if sum(item["mask"]) != item["answer_tokens"] + 1:
                print("mask_does_not_match_full_answer", item.get("source_file"), item.get("source_line"))
                return 2
        xs = [item["ids"] for item in kept_pack]
        ms = [item["mask"] for item in kept_pack]
        np.asarray(xs, dtype=np.uint16).tofile(args.data / f"{split}_x.bin")
        np.asarray(ms, dtype=np.uint8).tofile(args.data / f"{split}_m.bin")
        by_source: dict = {}
        for item in kept_pack:
            slot = by_source.setdefault(item.get("source_file"), {"packed": 0, "loss_tokens": 0})
            slot["packed"] += 1
            slot["loss_tokens"] += item["supervised_tokens"]
        report[split] = {
            "rows_in_jsonl": len(rows),
            "packed": len(kept_pack),
            "rejected": len(rejected),
            "truncated_answer_rows": 0,
            "truncated_tokens": 0,
            "loss_tokens": sum(item["supervised_tokens"] for item in kept_pack),
            "by_source": by_source,
            "rejected_rows": [
                {
                    "source_file": item.get("source_file"),
                    "source_line": item.get("source_line"),
                    "reason": item["reason"],
                    "prompt_tokens": item["prompt_tokens"],
                    "answer_tokens": item["answer_tokens"],
                    "ctx": item["ctx"],
                }
                for item in rejected
            ],
        }
        print(split, "packed", len(kept_pack), "rejected", len(rejected))
    reconcile = quality.get("reconcile") or {}
    train_rows = reconcile.get("train_rows", report["train"]["rows_in_jsonl"])
    val_rows = reconcile.get("val_rows", report["val"]["rows_in_jsonl"])
    identity = (
        train_rows == report["train"]["packed"] + report["train"]["rejected"]
        and val_rows == report["val"]["packed"] + report["val"]["rejected"]
    )
    exclusion_path = args.data / "exclusions.jsonl"
    context_drops = []
    if exclusion_path.is_file():
        for line in exclusion_path.read_bytes().decode("utf-8").split("\n"):
            if not line.strip():
                continue
            item = json.loads(line)
            if item.get("reason") in {"prompt_exceeds_context", "answer_exceeds_context"}:
                context_drops.append({
                    "source_file": item.get("source_file"),
                    "source_line": item.get("source_line"),
                    "reason": item.get("reason"),
                    "prompt_tokens": item.get("prompt_tokens"),
                    "answer_tokens": item.get("answer_tokens"),
                    "ctx": item.get("ctx"),
                })
    report["context_drops"] = context_drops
    steps = planned_steps(report["train"]["packed"])
    report["planned_steps"] = steps
    report["unused_tail_rows"] = report["train"]["packed"] % 32
    report["identity_jsonl_equals_packed_plus_rejected"] = identity
    if not identity:
        print("pack_reconcile_fail")
        return 2
    meta = {
        "ctx": CTX,
        "vocab_size": 32000,
        "n_train": report["train"]["packed"],
        "n_val": report["val"]["packed"],
        "origin": "catalogued sources, licenses not merged",
        "tokenizer_mode": mode,
        "planned_steps": steps,
        "pack": report,
    }
    (args.data / "meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    (args.data / "pack_report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    if quality:
        quality["planned_steps"] = steps
        quality["unused_tail_rows"] = report["unused_tail_rows"]
        reconcile["packed_train"] = report["train"]["packed"]
        reconcile["packed_val"] = report["val"]["packed"]
        reconcile["pack_rejected_train"] = report["train"]["rejected"]
        reconcile["pack_rejected_val"] = report["val"]["rejected"]
        reconcile["planned_steps"] = steps
        reconcile["identity_packed"] = identity
        reconcile["tokenizer_mode"] = mode
        quality["reconcile"] = reconcile
        quality_path.write_text(json.dumps(quality, indent=2) + "\n", encoding="utf-8")
    print("planned_steps", steps)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
