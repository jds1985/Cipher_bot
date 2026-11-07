#!/usr/bin/env python3
import json
import subprocess
import sys
import tempfile
from pathlib import Path

GATE = Path(__file__).resolve().parent / "sft_data_gate.py"


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")


def run(train: Path, val: Path, frozen: Path | None = None) -> subprocess.CompletedProcess[str]:
    cmd = [sys.executable, str(GATE), "--train", str(train), "--val", str(val)]
    if frozen:
        cmd += ["--frozen", str(frozen)]
    return subprocess.run(cmd, text=True, capture_output=True)


def main() -> int:
    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        good_tr, good_va = root / "tr.jsonl", root / "va.jsonl"
        write_jsonl(good_tr, [
            {"user": "What is 2 plus 2?", "assistant": "4."},
            {"user": "Name a primary color.", "assistant": "Red."},
        ])
        write_jsonl(good_va, [
            {"user": "What is 3 plus 3?", "assistant": "6."},
        ])
        ok = run(good_tr, good_va)
        assert ok.returncode == 0, ok.stdout + ok.stderr
        bad_tr = root / "bad.jsonl"
        write_jsonl(bad_tr, [{"user": "tell me a joke", "assistant": "Same line."}] * 8)
        bad = run(bad_tr, good_va)
        assert bad.returncode == 2 and "repeated 8" in bad.stdout
        leak_va = root / "leak.jsonl"
        write_jsonl(leak_va, [{"user": "What is 2 plus 2?", "assistant": "4."}])
        leak = run(good_tr, leak_va)
        assert leak.returncode == 2 and "val user" in leak.stdout
        frozen = root / "frozen.json"
        frozen.write_text(json.dumps({"prompts": [{"text": "What is 2 plus 2?"}]}), encoding="utf-8")
        fr = run(good_tr, good_va, frozen)
        assert fr.returncode == 2 and "frozen eval" in fr.stdout
        para = root / "para.jsonl"
        write_jsonl(para, [{"user": "What is 2 plus 2 please", "assistant": "4."}])
        other = root / "other.jsonl"
        write_jsonl(other, [{"user": "Name a primary color.", "assistant": "Red."}])
        clone = subprocess.run(
            [sys.executable, str(GATE), "--train", str(para), "--val", str(other),
             "--frozen", str(frozen), "--lexical-jaccard", "0.5"],
            text=True, capture_output=True)
        assert clone.returncode == 2 and "lexical clones" in clone.stdout, clone.stdout
    print("sft data gate ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
