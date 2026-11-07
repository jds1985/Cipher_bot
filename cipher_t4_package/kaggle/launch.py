#!/usr/bin/env python3
"""Private Kaggle entry. The package is read from /kaggle/input, not from cwd.

Kernel metadata cannot set PARENT_REVIEWED. This script ignores that variable.
Training starts only when the pack directory contains review_receipt.json and
its hashes match the mounted quality, reconcile, and pack report.

Mounts, from kaggle/mounts.json and kernel-metadata.json:
- code: /kaggle/input/cipher-general-sft-v6-code
- pack: /kaggle/input/cipher-general-sft-v6-pack
- model: /kaggle/input/cipher2m-sft-v3-model
A dataset attached with dir-mode zip may contain a .zip instead of loose files.
Those archives are extracted under the writable working directory. Nothing is
downloaded.
"""

from __future__ import annotations

import hashlib
import importlib
import json
import os
import sys
import zipfile
from pathlib import Path

CODE_MOUNT = "cipher-general-sft-v6-code"
PACK_MOUNT = "cipher-general-sft-v6-pack"
MODEL_MOUNT = "cipher2m-sft-v3-model"
MODEL_FILE = "sft_model.pt"
MODEL_BYTES = 1474893963
MODEL_SHA = "7c1b337f5e4a0e0b4636201682974b24c69682932dfedefce48bf180500d77e9"
HERE = Path(__file__).resolve().parent


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def input_root() -> Path:
    return Path(os.environ.get("KAGGLE_INPUT_ROOT", "/kaggle/input"))


def working_root() -> Path:
    return Path(os.environ.get("KAGGLE_WORKING", "/kaggle/working"))


def mount_dir(root: Path, name: str) -> Path:
    return root / name


def extract_zip(archive: Path, dest: Path) -> Path:
    dest.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as handle:
        handle.extractall(dest)
    return dest


def find_named(root: Path, filename: str) -> Path | None:
    if not root.exists():
        return None
    direct = list(root.rglob(filename)) if root.is_dir() else []
    if direct:
        return direct[0]
    if root.is_dir():
        for archive in sorted(root.rglob("*.zip")):
            dest = working_root() / "unpacked" / archive.stem
            if not dest.exists():
                extract_zip(archive, dest)
            found = list(dest.rglob(filename))
            if found:
                return found[0]
    return None


def dependency_report() -> dict:
    report = {"missing": [], "versions": {}, "cuda": False, "cuda_devices": 0}
    for name in ("torch", "numpy", "tokenizers"):
        try:
            module = importlib.import_module(name)
        except ImportError:
            report["missing"].append(name)
            continue
        report["versions"][name] = getattr(module, "__version__", "unknown")
    if "torch" in report["versions"]:
        import torch
        report["cuda"] = bool(torch.cuda.is_available())
        report["cuda_devices"] = int(torch.cuda.device_count()) if report["cuda"] else 0
    return report


def receipt_ok(pack: Path) -> tuple[bool, str]:
    path = pack / "review_receipt.json"
    if not path.is_file():
        return False, "review_receipt_missing"
    receipt = json.loads(path.read_text(encoding="utf-8"))
    if receipt.get("reviewed") is not True:
        return False, "review_receipt_not_true"
    for key, filename in (
        ("quality_sha256", "quality.json"),
        ("reconcile_sha256", "reconcile.json"),
        ("pack_report_sha256", "pack_report.json"),
    ):
        target = pack / filename
        if not target.is_file() or sha256(target) != receipt.get(key):
            return False, f"review_receipt_hash_mismatch {key}"
    quality = json.loads((pack / "quality.json").read_text(encoding="utf-8"))
    if quality.get("gate") != "ok":
        return False, "quality_gate_closed"
    return True, "review_receipt_ok"


def assess(root: Path | None = None) -> dict:
    root = root or input_root()
    code_mount = mount_dir(root, CODE_MOUNT)
    pack_mount = mount_dir(root, PACK_MOUNT)
    model_mount = mount_dir(root, MODEL_MOUNT)
    train_py = find_named(code_mount, "train_t4.py")
    train_bin = find_named(pack_mount, "train_x.bin")
    model = find_named(model_mount, MODEL_FILE)
    deps = dependency_report()
    pack_dir = train_bin.parent if train_bin else None
    receipt_state = "pack_missing"
    if pack_dir is not None:
        _ok, receipt_state = receipt_ok(pack_dir)
    report = {
        "input_root": str(root),
        "code_mount": str(code_mount),
        "pack_mount": str(pack_mount),
        "model_mount": str(model_mount),
        "train_t4": str(train_py) if train_py else None,
        "train_x": str(train_bin) if train_bin else None,
        "model": str(model) if model else None,
        "dependencies": deps,
        "receipt": receipt_state,
        "parent_reviewed_env_ignored": True,
    }
    return report


def main() -> int:
    os.environ.pop("PARENT_REVIEWED", None)
    report = assess()
    print("kaggle_preflight " + json.dumps(report, sort_keys=True))
    deps = report["dependencies"]
    if deps["missing"]:
        print("offline_deps_missing", " ".join(deps["missing"]))
        return 2
    if report["train_t4"] is None or report["train_x"] is None or report["model"] is None:
        print("mount_incomplete")
        return 2
    pack = Path(report["train_x"]).parent
    ok, reason = receipt_ok(pack)
    if not ok:
        print(reason)
        return 2
    model = Path(report["model"])
    if model.stat().st_size != MODEL_BYTES or sha256(model) != MODEL_SHA:
        print("base_refused")
        return 2
    if not deps["cuda"] or deps["cuda_devices"] != 1:
        print("cuda_preflight_failed", deps["cuda_devices"])
        return 2
    package = Path(report["train_t4"]).resolve().parent
    sys.path.insert(0, str(package / "lib"))
    from disk_preflight import REAL_DISK_NEED, require_free
    if not require_free(working_root() / "run", REAL_DISK_NEED):
        return 2
    sys.path.insert(0, str(package))
    tokenizers = list(pack.rglob("tokenizer.json"))
    if not tokenizers:
        print("tokenizer_missing")
        return 2
    os.environ["CIPHER2_TOKENIZER"] = str(tokenizers[0])
    sys.argv = [
        "train_t4.py", "--data", str(pack), "--base", str(model),
        "--out", str(working_root() / "run"), "--launch",
    ]
    import train_t4
    return train_t4.main()


if __name__ == "__main__":
    raise SystemExit(main())
