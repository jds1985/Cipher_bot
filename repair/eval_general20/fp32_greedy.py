#!/usr/bin/env python3
"""Greedy FP32 decode of the general-v1 prompts from sft_model.pt.

Does not sample. --rep 1 is pure argmax. --rep 1.15 divides or multiplies
seen-token logits and then takes argmax, still with no RNG.
The first action on a real file is a finite-weight check. Missing weights exit 2.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "general_sft" / "vendor"))

EXPECTED = "7c1b337f5e4a0e0b4636201682974b24c69682932dfedefce48bf180500d77e9"
EXPECTED_BYTES = 1474893963
STOP = {0, 1, 2, 3, 4}


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def finite_report(state) -> str:
    import torch
    bad = []
    for name, tensor in state.items():
        if tensor.is_floating_point() and not torch.isfinite(tensor).all():
            bad.append(name)
    return "finite" if not bad else "nonfinite " + ",".join(bad[:8])


def decode(model, ids: list[int], max_new: int, rep: float, tok) -> dict:
    import torch
    x = torch.tensor([ids], dtype=torch.long)
    seen = set(i for i in ids if 0 <= i < 32000)
    out = []
    stop = None
    with torch.no_grad():
        for _ in range(max_new):
            logits = model(x[:, -model.max_len:])[0, -1].float()
            if rep != 1.0:
                for i in seen:
                    logits[i] = logits[i] / rep if logits[i] > 0 else logits[i] * rep
            nxt = int(torch.argmax(logits).item())
            if nxt in STOP:
                stop = nxt
                break
            out.append(nxt)
            seen.add(nxt)
            x = torch.cat([x, torch.tensor([[nxt]])], 1)
    text = tok.decode(out, skip_special_tokens=False)
    return {"tokens": out, "stop": stop, "n": len(out), "text": text, "rep": rep, "rng": False}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pt", type=Path)
    ap.add_argument("--ids", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--rep", type=float, default=1.0)
    ap.add_argument("--max-new", type=int, default=128)
    ap.add_argument("--limit", type=int, default=20)
    args = ap.parse_args()
    if args.pt is None or not args.pt.is_file():
        print("pt_missing pass --pt /workspace/cipher2_improve/kaggle_v3/out_v3/final/sft_model.pt")
        return 2
    size = args.pt.stat().st_size
    digest = sha256(args.pt)
    print(f"sha256 {digest} bytes {size}")
    if digest != EXPECTED or size != EXPECTED_BYTES:
        print("pt_refused hash or size is not the logged SFTv3 file")
        return 2
    import torch
    from tokenizers import Tokenizer
    from model import CipherTern
    ck = torch.load(args.pt, map_location="cpu", weights_only=False)
    report = finite_report(ck["model"])
    print("weights", report)
    if report != "finite":
        return 2
    model = CipherTern(ck["meta"]["vocab_size"], **ck["config"])
    model.load_state_dict(ck["model"])
    model.eval()
    tok = Tokenizer.from_file(str(ROOT.parent / "native" / "cipher-wasm" / "fixtures" / "tokenizer.json"))
    lines = []
    for n, line in enumerate(args.ids.read_text(encoding="utf-8").splitlines()):
        if n >= args.limit or not line.strip():
            continue
        ident, raw = line.split("\t", 1)
        ids = [int(x) for x in raw.split(",") if x]
        row = decode(model, ids, args.max_new, args.rep, tok)
        row["id"] = ident
        row["prompt_tokens"] = len(ids)
        lines.append(json.dumps(row, ensure_ascii=False))
        print(ident, row["n"], row["text"][:80].replace("\n", " "))
    args.out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
