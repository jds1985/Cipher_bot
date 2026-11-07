#!/usr/bin/env python3
"""Write the review receipt the Kaggle entry requires. Does not train.

The kernel metadata cannot carry PARENT_REVIEWED. The entry ignores that
variable. It starts only when this receipt sits in the pack directory and its
hashes match the mounted quality, reconcile, and pack report.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pack", type=Path, required=True)
    ap.add_argument("--out", type=Path)
    args = ap.parse_args()
    quality = json.loads((args.pack / "quality.json").read_text(encoding="utf-8"))
    reconcile = json.loads((args.pack / "reconcile.json").read_text(encoding="utf-8"))
    report = json.loads((args.pack / "pack_report.json").read_text(encoding="utf-8"))
    if quality.get("gate") != "ok" or not reconcile.get("identity_ok"):
        print("receipt_refused")
        return 2
    receipt = {
        "reviewed": True,
        "quality_sha256": sha256(args.pack / "quality.json"),
        "reconcile_sha256": sha256(args.pack / "reconcile.json"),
        "pack_report_sha256": sha256(args.pack / "pack_report.json"),
        "train_rows": reconcile.get("train_rows"),
        "planned_steps": report.get("planned_steps"),
        "gate": quality.get("gate"),
    }
    dest = args.out or (args.pack / "review_receipt.json")
    dest.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print("review_receipt", dest)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
