#!/usr/bin/env python3
"""Greedy FP32 decode. No RNG. Rep 1 is argmax. Rep other than 1 is argmax after the penalty."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE / "vendor"))
EXPECTED = "7c1b337f5e4a0e0b4636201682974b24c69682932dfedefce48bf180500d77e9"
EXPECTED_BYTES = 1474893963
STOP = {0, 1, 2, 3, 4}


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pt", type=Path)
    ap.add_argument("--ids", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--tokenizer", type=Path, required=True)
    ap.add_argument("--rep", type=float, default=1.0)
    ap.add_argument("--max-new", type=int, default=128)
    ap.add_argument("--limit", type=int, default=28)
    args = ap.parse_args()
    if args.pt is None or not args.pt.is_file():
        print("pt_missing")
        return 2
    if args.pt.stat().st_size != EXPECTED_BYTES or sha256(args.pt) != EXPECTED:
        print("pt_refused")
        return 2
    import torch
    from tokenizers import Tokenizer
    from model import CipherTern
    ck = torch.load(args.pt, map_location="cpu", weights_only=False)
    bad = [n for n, t in ck["model"].items() if t.is_floating_point() and not torch.isfinite(t).all()]
    print("weights", "finite" if not bad else "nonfinite")
    if bad:
        return 2
    model = CipherTern(ck["meta"]["vocab_size"], **ck["config"])
    model.load_state_dict(ck["model"])
    model.eval()
    tok = Tokenizer.from_file(str(args.tokenizer))
    lines = []
    for n, line in enumerate(args.ids.read_text(encoding="utf-8").splitlines()):
        if n >= args.limit or not line.strip():
            continue
        ident, raw = line.split("\t", 1)
        ids = [int(x) for x in raw.split(",") if x]
        x = torch.tensor([ids], dtype=torch.long)
        seen = set(i for i in ids if 0 <= i < 32000)
        out, stop = [], None
        with torch.no_grad():
            for _ in range(args.max_new):
                logits = model(x[:, -model.max_len:])[0, -1].float()
                if args.rep != 1.0:
                    for i in seen:
                        logits[i] = logits[i] / args.rep if logits[i] > 0 else logits[i] * args.rep
                nxt = int(torch.argmax(logits).item())
                if nxt in STOP:
                    stop = nxt
                    break
                out.append(nxt)
                seen.add(nxt)
                x = torch.cat([x, torch.tensor([[nxt]])], 1)
        row = {"id": ident, "tokens": out, "stop": stop, "n": len(out), "text": tok.decode(out), "rep": args.rep, "rng": False}
        lines.append(json.dumps(row, ensure_ascii=False))
    args.out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
