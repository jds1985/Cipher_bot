#!/usr/bin/env python3
"""Throwaway CPU smoke of the trainer loop. Not a quality run and not a candidate.

Two steps, one validation, a checkpoint write, and a weights_only reload.
The model is a tiny CipherTern, not the 369M checkpoint. Output is deleted.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path

import numpy as np
import torch

HERE = Path(__file__).resolve().parent


def main() -> int:
    root = Path(os.environ.get("SMOKE_DIR", "/tmp/cipher_smoke_throwaway"))
    if root.exists():
        shutil.rmtree(root)
    data, out, base_dir = root / "data", root / "out", root / "base"
    for path in (data, out, base_dir):
        path.mkdir(parents=True)
    vocab, ctx, n = 128, 64, 4
    # The packaged trainer requires context 1024. A tiny width keeps this on CPU.
    ctx = 1024
    rng = np.random.default_rng(0)
    train_x = rng.integers(0, vocab, size=(n, ctx), dtype=np.uint16)
    val_x = rng.integers(0, vocab, size=(n, ctx), dtype=np.uint16)
    train_m = np.zeros((n, ctx), dtype=np.uint8)
    val_m = np.zeros((n, ctx), dtype=np.uint8)
    train_m[:, -8:] = 1
    val_m[:, -8:] = 1
    train_x.tofile(data / "train_x.bin")
    val_x.tofile(data / "val_x.bin")
    train_m.tofile(data / "train_m.bin")
    val_m.tofile(data / "val_m.bin")
    (data / "val_sources.json").write_text(json.dumps(["smoke_a", "smoke_a", "smoke_b", "smoke_b"]) + "\n", encoding="utf-8")
    (data / "meta.json").write_text(json.dumps({"ctx": ctx, "vocab_size": vocab}) + "\n", encoding="utf-8")
    sys.path.insert(0, str(HERE / "vendor"))
    from model import CipherTern
    model = CipherTern(vocab, d_model=32, n_layers=1, n_heads=4, max_len=ctx, ternary=True, quantize_act=True)
    config = {"d_model": 32, "n_layers": 1, "n_heads": 4, "max_len": ctx, "ternary": True, "quantize_act": True}
    base = base_dir / "tiny.pt"
    torch.save({"model": model.state_dict(), "config": config, "step": 0, "val_loss": None}, base)
    os.environ["SFT_ALLOW_SMALL"] = "1"
    os.environ.pop("SFT_PROBE_FILE", None)
    sys.argv = [
        "sft_train.py", "--data", str(data), "--base", str(base), "--out", str(out),
        "max_steps=2", "batch_size=2", "grad_accum=1", "warmup=1", "eval_every=1", "eval_batches=1",
        "ckpt_every=1", "time_limit_h=1", "lr=1e-3", "seed=1", "amp=false",
    ]
    import sft_train
    sft_train.main()
    latest = out / "ckpt" / "latest.pt"
    best = out / "ckpt" / "best.pt"
    if not latest.is_file() or not best.is_file():
        print("smoke_missing_checkpoint")
        return 2
    ck = torch.load(latest, map_location="cpu", weights_only=True)
    if ck.get("kind") != "sft" or ck.get("step") != 2 or "model" not in ck:
        print("smoke_reload_mismatch", ck.get("kind"), ck.get("step"))
        return 2
    reloaded = CipherTern(vocab, **config)
    reloaded.load_state_dict(ck["model"])
    log = (out / "log.csv").read_text(encoding="utf-8")
    subset = json.loads((out / "val_subset.json").read_text(encoding="utf-8"))
    best_ck = torch.load(best, map_location="cpu", weights_only=True)
    if "selection_loss" not in log or log.count("\n") < 2:
        print("smoke_missing_val")
        return 2
    if best_ck.get("selection_subset_sha256") != subset["sha256"]:
        print("smoke_subset_mismatch")
        return 2
    if best_ck.get("best_step") not in (0, 2):
        print("smoke_best_step", best_ck.get("best_step"))
        return 2
    print("smoke_ok steps 2 checkpoint_reloaded val_logged not_a_candidate")
    shutil.rmtree(root)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
