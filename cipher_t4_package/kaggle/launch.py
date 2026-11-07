#!/usr/bin/env python3
"""Private free-T4 Kaggle entry. This does not run unless PARENT_REVIEWED=1.

train_t4.py --launch starts the trainer in the current process. It does not
create or submit this kernel. Upload a private notebook, set the accelerator
to the free T4, leave internet off, and attach:

- this package directory
- the packed out/ directory (bins, quality.json, pack_report.json, reconcile.json, val_sources.json)
- sft_model.pt, 1474893963 bytes, sha256 7c1b337f5e4a0e0b4636201682974b24c69682932dfedefce48bf180500d77e9
- the same tokenizer.json recorded in reconcile.json

Dolly is CC BY-SA 3.0 and SQuAD is CC BY-SA 4.0. ShareAlike on trained weights
is unresolved. A private experiment does not clear distribution.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PACKAGE = HERE.parent
sys.path.insert(0, str(PACKAGE / "vendor"))
from common import find_one  # noqa: E402


def main() -> int:
    data = os.environ.get("SFT_DATA") or find_one("train_x.bin")
    if data and data.endswith("train_x.bin"):
        data = str(Path(data).parent)
    base = os.environ.get("SFT_BASE") or find_one("sft_model.pt")
    print("kaggle_entry data", data or "missing", "base", base or "missing")
    print("train_t4 --launch does not submit Kaggle. This script is the kernel entry.")
    if os.environ.get("PARENT_REVIEWED") != "1":
        print("not_started set PARENT_REVIEWED=1 after reading quality.json, reconcile.json, and pack_report.json")
        return 0
    if not data or not base:
        print("attach_packed_out_and_sft_model")
        return 2
    sys.path.insert(0, str(PACKAGE))
    sys.argv = [
        "train_t4.py", "--data", data, "--base", base,
        "--out", os.environ.get("SFT_OUT", "/kaggle/working/run"), "--launch",
    ]
    import train_t4
    return train_t4.main()


if __name__ == "__main__":
    raise SystemExit(main())
