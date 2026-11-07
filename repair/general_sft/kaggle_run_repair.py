#!/usr/bin/env python3
"""Kaggle entry for the general repair. Does not start unless PARENT_REVIEWED=1.

Uses the free T4 path already used for the hotel run. Refuses every base file
except sha256 7c1b337f5e4a0e0b4636201682974b24c69682932dfedefce48bf180500d77e9.
Does not fall back to SFTv2 or a pretrain latest.pt. Does not upload anything.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def main() -> int:
    os.environ.setdefault("SFT_MAX_STEPS_CAP", "9")
    sys.path.insert(0, str(HERE))
    argv = [sys.argv[0]]
    if os.environ.get("PARENT_REVIEWED") == "1":
        argv.append("--parent-reviewed")
    if os.environ.get("TWO_EPOCHS") == "1":
        argv.append("--two-epochs")
    base = os.environ.get("SFT_BASE")
    if base:
        argv += ["--base", base]
    sys.argv = argv
    import train_repair
    return train_repair.main()


if __name__ == "__main__":
    sys.exit(main())
