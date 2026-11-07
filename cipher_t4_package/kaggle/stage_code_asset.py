#!/usr/bin/env python3
"""Build the private code dataset. Held-out fixtures are not included."""

from __future__ import annotations

import argparse
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
SKIP = ("fixtures/", "out-selftest/", "out-proportional/", "__pycache__/")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(args.out, "w", zipfile.ZIP_DEFLATED) as handle:
        for path in HERE.rglob("*"):
            if not path.is_file():
                continue
            rel = path.relative_to(HERE).as_posix()
            if rel.startswith(SKIP) or "/__pycache__/" in f"/{rel}":
                continue
            handle.write(path, f"cipher_t4_package/{rel}")
    print(args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
