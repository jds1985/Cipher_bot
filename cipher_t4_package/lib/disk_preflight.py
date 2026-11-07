"""Free-space check before optimizer checkpoints are written.

One real Cipher checkpoint with Adam state is about 4.4 GiB. latest.pt,
best.pt, and the temporary file used by an atomic replace can exist together,
so the floor is three times that size. A smaller model uses its own byte count.
"""

from __future__ import annotations

import shutil
from pathlib import Path

REAL_CKPT_BYTES = int(4.4 * (1024 ** 3))
REAL_DISK_NEED = REAL_CKPT_BYTES * 3


def free_bytes(path: Path) -> int:
    path.mkdir(parents=True, exist_ok=True)
    return shutil.disk_usage(path).free


def require_free(path: Path, need: int) -> bool:
    free = free_bytes(path)
    print(f"disk_free {free} disk_need {need} path {path}")
    if free < need:
        print("disk_insufficient")
        return False
    return True
