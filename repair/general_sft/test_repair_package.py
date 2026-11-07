#!/usr/bin/env python3
"""Checks the repair package without loading the base checkpoint or training."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[1]


def main() -> int:
    builder = (ROOT / "build_rows.py").read_text(encoding="utf-8")
    assert "general-v2" not in builder
    assert "frozen" not in builder
    held_sha = (ROOT / "frozen" / "general-v2.sha256").read_text().split()[0]
    assert held_sha == "3c15169dfd848b57209b71813f75f972c74c35a0ce745c803376db33cb1323f9"
    doc = json.loads((ROOT / "frozen" / "general-v2.json").read_text(encoding="utf-8"))
    assert len(doc["prompts"]) == 28
    assert "assistant" not in doc["prompts"][0]
    subprocess.check_call([sys.executable, str(ROOT / "build_rows.py")])
    subprocess.check_call([
        sys.executable, str(REPO / "scripts" / "sft_data_gate.py"),
        "--train", str(ROOT / "data" / "train.jsonl"),
        "--val", str(ROOT / "data" / "val.jsonl"),
        "--frozen", str(ROOT / "frozen" / "general-v2.json"),
        "--frozen", str(REPO / "native" / "cipher-wasm" / "fixtures" / "general-v1.json"),
        "--frozen", str(ROOT / "probes" / "early_stop.json"),
        "--lexical-jaccard", "0.72",
        "--ban", "front desk", "--ban", "call 911",
    ])
    subprocess.check_call([sys.executable, str(ROOT / "pack_bins.py")])
    subprocess.check_call([sys.executable, str(ROOT / "export_parity.py"), "--self-test"])
    out = subprocess.check_output([sys.executable, str(ROOT / "train_repair.py")], text=True)
    assert "not_started" in out
    assert "7c1b337f5e4a0e0b4636201682974b24c69682932dfedefce48bf180500d77e9" in out
    # one packed row: loss bits sit on the assistant text and the final EOT only
    import numpy as np
    from tokenizers import Tokenizer
    sys.path.insert(0, str(ROOT))
    import pack_bins
    tok = Tokenizer.from_file(str(REPO / "native" / "cipher-wasm" / "fixtures" / "tokenizer.json"))
    row = json.loads((ROOT / "data" / "train.jsonl").read_text().splitlines()[0])
    ids, mask = pack_bins.encode_row(tok, row)
    body = tok.encode(row["assistant"], add_special_tokens=False).ids
    assert sum(mask) == len(body) + 1
    assert ids[mask.index(1):sum(mask) + mask.index(1)] == body + [0]
    x = np.fromfile(ROOT / "data" / "train_x.bin", dtype=np.uint16).reshape(-1, 1024)
    assert x.shape[0] == 36
    print("repair package ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
