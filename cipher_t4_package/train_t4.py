#!/usr/bin/env python3
"""One-epoch T4 training after quality.json says the gate passed.

Does not read the held-out prompt file. Refuses a base that is not the logged
SFTv3 checkpoint. Does not start unless --launch is present.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
BASE_SHA = "7c1b337f5e4a0e0b4636201682974b24c69682932dfedefce48bf180500d77e9"
BASE_BYTES = 1474893963


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=Path, required=True)
    ap.add_argument("--base", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--launch", action="store_true")
    args = ap.parse_args()
    quality = json.loads((args.data / "quality.json").read_text(encoding="utf-8"))
    if quality.get("gate") != "ok":
        print("quality_gate_closed")
        return 2
    n = quality["train"]["rows"]
    steps = max(1, min(800, n // 32 or 1))
    print(f"planned_steps {steps} batch 4 grad_accum 8 lr 2e-5 time_limit_h 3")
    print("about 3212 padded tokens/s and 11.5 GB were measured on the v3 run at this batch")
    if not args.launch:
        print("not_launched review quality.json then pass --launch")
        return 0
    if not args.base.is_file():
        print("base_missing")
        return 2
    if args.base.stat().st_size != BASE_BYTES or sha256(args.base) != BASE_SHA:
        print("base_refused")
        return 2
    os.environ["SFT_MAX_STEPS_CAP"] = "800"
    sys.path.insert(0, str(HERE / "vendor"))
    sys.argv = [
        "sft_train.py", "--data", str(args.data), "--base", str(args.base), "--out", str(args.out),
        f"max_steps={steps}", "lr=2e-5", "warmup=20", "batch_size=4", "grad_accum=8",
        "eval_every=50", "ckpt_every=100", "time_limit_h=3", "seed=20261107",
    ]
    import sft_train
    sft_train.main()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
