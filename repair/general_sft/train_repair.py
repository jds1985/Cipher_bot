#!/usr/bin/env python3
"""Prepare, and only after an explicit review flag, run one short SFTv3 repair.

Does not start training unless --parent-reviewed is present. The base torch file
must match the logged SFTv3 sha256. There is no fallback to another checkpoint.
Held-out general-v2 is not read by the row builder. This script runs the data
gate, then refuses to exceed 9 optimizer steps (18 only with --two-epochs).
"""

from __future__ import annotations

import argparse
import hashlib
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[1]
BASE_SHA = "7c1b337f5e4a0e0b4636201682974b24c69682932dfedefce48bf180500d77e9"
BASE_BYTES = 1474893963
DEFAULT_BASES = [
    Path("/workspace/cipher2_improve/kaggle_v3/out_v3/final/sft_model.pt"),
    Path("/workspace/cipher2_improve/kaggle_v3/package/ds_v3model/sft_model.pt"),
]


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def gate() -> None:
    cmd = [
        sys.executable, str(REPO / "scripts" / "sft_data_gate.py"),
        "--train", str(ROOT / "data" / "train.jsonl"),
        "--val", str(ROOT / "data" / "val.jsonl"),
        "--frozen", str(ROOT / "frozen" / "general-v2.json"),
        "--frozen", str(REPO / "native" / "cipher-wasm" / "fixtures" / "general-v1.json"),
        "--frozen", str(ROOT / "probes" / "early_stop.json"),
        "--lexical-jaccard", "0.72",
        "--ban", "front desk", "--ban", "call 911", "--ban", "on file for this hotel", "--ban", "late checkout",
    ]
    subprocess.check_call(cmd)


def resolve_base(arg: str | None) -> Path | None:
    if arg:
        return Path(arg)
    for path in DEFAULT_BASES:
        if path.is_file():
            return path
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=None)
    ap.add_argument("--parent-reviewed", action="store_true")
    ap.add_argument("--two-epochs", action="store_true")
    ap.add_argument("--out", default=str(ROOT / "run"))
    args = ap.parse_args()
    held = (ROOT / "frozen" / "general-v2.sha256").read_text().split()[0]
    print("heldout_general_v2_sha256", held)
    print("expected_base_sha256", BASE_SHA)
    print("expected_base_bytes", BASE_BYTES)
    gate()
    cap = 18 if args.two_epochs else 9
    print(f"step_cap {cap} lr 1e-5 batch 2 grad_accum 2 warmup 1")
    print("early_stop hotel template or a format probe longer than 8 words")
    print("success_is_not_claimed run general-v2 in the browser after export; do not score general-v1 as unseen")
    if not args.parent_reviewed:
        print("not_started pass --parent-reviewed after reviewing the rows and this gate")
        return 0
    base = resolve_base(args.base)
    if base is None or not base.is_file():
        print("base_missing the logged sft_model.pt is not visible at the default paths")
        return 2
    size = base.stat().st_size
    digest = sha256(base)
    print("base", base, "bytes", size, "sha256", digest)
    if size != BASE_BYTES or digest != BASE_SHA:
        print("base_refused hash or size does not match the logged SFTv3 file")
        return 2
    os.environ["SFT_PROBE_FILE"] = str(ROOT / "probes" / "early_stop.json")
    os.environ["SFT_MAX_STEPS_CAP"] = str(cap)
    os.environ["CIPHER2_TOKENIZER"] = str(REPO / "native" / "cipher-wasm" / "fixtures" / "tokenizer.json")
    sys.path.insert(0, str(ROOT / "vendor"))
    sys.argv = [
        "sft_train.py", "--data", str(ROOT / "data"), "--base", str(base), "--out", args.out,
        "max_steps=" + str(cap), "epochs=1", "eval_every=3", "eval_batches=0", "ckpt_every=3",
        "batch_size=2", "grad_accum=2", "lr=1e-5", "warmup=1", "seed=20261107",
        "time_limit_h=2.0", "ckpt_minutes=30",
    ]
    import sft_train
    sft_train.main()
    return 0


if __name__ == "__main__":
    sys.exit(main())
