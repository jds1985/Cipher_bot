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
sys.path.insert(0, str(HERE / "lib"))
from plan import MAX_STEPS, schedule  # noqa: E402
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
    reconcile = quality.get("reconcile") or {}
    if not reconcile.get("identity_ok") or not reconcile.get("identity_packed"):
        print("reconcile_incomplete")
        return 2
    pack_path = args.data / "pack_report.json"
    if not pack_path.is_file():
        print("pack_required")
        return 2
    pack = json.loads(pack_path.read_text(encoding="utf-8"))
    if pack.get("tokenizer_mode") != "huggingface":
        print("tokenizer_mode_refused")
        return 2
    if pack.get("truncated_answer_rows", 1) or pack["train"].get("truncated_answer_rows", 1):
        print("answer_truncation_refused")
        return 2
    plan = schedule(pack["train"]["packed"])
    steps = plan["planned_steps"]
    if quality.get("planned_steps") != steps or pack.get("planned_steps") != steps:
        print("planned_steps_mismatch")
        return 2
    if pack.get("schedule", {}).get("rows_unseen_if_plan_completes") != plan["rows_unseen_if_plan_completes"]:
        print("schedule_mismatch")
        return 2
    print(
        f"planned_steps {steps} epoch_steps {plan['epoch_steps']} partial_batch_rows {plan['partial_batch_rows']} "
        f"rows_cut_by_step_cap {plan['rows_cut_by_step_cap']} rows_unseen_if_plan_completes {plan['rows_unseen_if_plan_completes']}"
    )
    print(f"illustrative_train_hours {plan['illustrative_train_hours']} prior_tok_s {plan['prior_padded_tokens_per_s']}")
    print(plan["estimate"])
    print("interim validation is 100 batches every 100 steps. Full validation runs at the start, and at the end only if the clock can cover it.")
    print("this command starts the trainer here. It does not submit a Kaggle kernel.")
    if not args.launch:
        print("not_launched review quality.json then pass --launch")
        return 0
    if not args.base.is_file():
        print("base_missing")
        return 2
    if args.base.stat().st_size != BASE_BYTES or sha256(args.base) != BASE_SHA:
        print("base_refused")
        return 2
    os.environ["SFT_MAX_STEPS_CAP"] = str(MAX_STEPS)
    sys.path.insert(0, str(HERE / "vendor"))
    sys.argv = [
        "sft_train.py", "--data", str(args.data), "--base", str(args.base), "--out", str(args.out),
        f"max_steps={steps}", "lr=2e-5", "warmup=20", "batch_size=4", "grad_accum=8",
        "eval_every=100", "eval_batches=100", "ckpt_every=100", "time_limit_h=3", "seed=20261107",
    ]
    import sft_train
    sft_train.main()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
