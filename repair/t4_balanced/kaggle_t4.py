#!/usr/bin/env python3
"""One-epoch T4 run of a gated general mix. Training starts only with PARENT_REVIEWED=1.

Measured v3 speed was about 3212 padded tokens/s and 11.5 GB at batch 4.
Steps default to one pass over the packed rows, capped at 800.
The base file must match the logged SFTv3 sha256. This does not use the 36-row toy.
"""

from __future__ import annotations

import hashlib
import os
import sys
from pathlib import Path

BASE_SHA = "7c1b337f5e4a0e0b4636201682974b24c69682932dfedefce48bf180500d77e9"
BASE_BYTES = 1474893963


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def planned_steps(data: str | None) -> int:
    if not data:
        return 626
    meta = Path(data) / "train.jsonl"
    if not meta.is_file():
        return 626
    n = sum(1 for line in meta.read_text(encoding="utf-8").splitlines() if line.strip())
    return max(1, min(800, n // 32 or 1))


def main() -> int:
    data = os.environ.get("SFT_DATA", "")
    steps = planned_steps(data)
    argv = [
        "sft_train.py", "--data", data or "DATA", "--base", os.environ.get("SFT_BASE", "BASE"),
        "--out", os.environ.get("SFT_OUT", "/kaggle/working/run"),
        f"max_steps={steps}", "lr=2e-5", "warmup=20", "batch_size=4", "grad_accum=8",
        "eval_every=50", "ckpt_every=100", "time_limit_h=3", "seed=20261107",
    ]
    print("planned", " ".join(argv))
    print("base_sha256", BASE_SHA, "bytes", BASE_BYTES)
    if os.environ.get("PARENT_REVIEWED") != "1":
        print("not_started set PARENT_REVIEWED=1 only after license confirmation and the data gate")
        return 0
    base = Path(os.environ.get("SFT_BASE", ""))
    if not base.is_file() or not data:
        print("base_or_data_missing")
        return 2
    if base.stat().st_size != BASE_BYTES or sha256(base) != BASE_SHA:
        print("base_refused")
        return 2
    os.environ["SFT_MAX_STEPS_CAP"] = "800"
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "general_sft" / "vendor"))
    sys.argv = argv
    import sft_train
    sft_train.main()
    return 0


if __name__ == "__main__":
    sys.exit(main())
