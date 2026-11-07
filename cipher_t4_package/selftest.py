#!/usr/bin/env python3
"""Adversarial checks for the pack. Uses only files inside this directory."""

from __future__ import annotations

import json
import subprocess
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
ADV = HERE / "fixtures" / "adversarial"


def row(user: str, assistant: str) -> str:
    return json.dumps({"messages": [
        {"role": "user", "content": user},
        {"role": "assistant", "content": assistant},
    ]}) + "\n"


def write_adv() -> None:
    ADV.mkdir(parents=True, exist_ok=True)
    files = {
        "dolly_15k_human_cc_by_sa_3_0.jsonl": [
            row("What is the capital of France?", "Paris."),
            row("Please tell me the capital of France.", "Paris."),
            row("As an AI language model I refuse.", "I cannot."),
            row("Same dolly question about brass hinges.", "Brass hinges turn."),
            row("Same dolly question about brass hinges.", "Duplicate must drop."),
        ] + [row(f"Dolly unique question number {i} about gardens.", f"Garden note {i}.") for i in range(24)],
        "oasst2_en_human_apache_2_0.jsonl": [row(f"OASST question {i} about rivers.", f"River note {i}.") for i in range(12)],
        "aya_dataset_en_original_annotations_human_apache_2_0.jsonl": [row(f"Aya question {i} about cloth.", f"Cloth note {i}.") for i in range(12)],
        "squad_v2_passage_qa_human_cc_by_sa_4_0_capped.jsonl": [row(f"SQuAD passage question {i} about bridges.", f"Bridge note {i}.") for i in range(12)],
        "mbpp_human_cc_by_4_0.jsonl": [row(f"MBPP task {i} write a function.", f"def f{i}():\n    return {i}") for i in range(12)],
        "gsm8k_train_human_mit.jsonl": [row(f"GSM problem {i}: 3 bags plus {i}.", f"{3+i}") for i in range(12)],
        "cnn_dailymail_3_0_0_summarization_human_highlights_apache_2_.jsonl": [row("CNN story that must be excluded.", "Summary.")],
        "synthetic_identity_many_phrasings_code.jsonl": [row("Who are you in the synthetic file?", "Cipher.")],
        "unknown_notes.jsonl": [row("Uncatalogued source question.", "Drop me.")],
    }
    for name, lines in files.items():
        (ADV / name).write_text("".join(lines), encoding="utf-8")


def main() -> int:
    write_adv()
    proc = subprocess.run([sys.executable, str(HERE / "build_balanced.py"), "--self-test"], text=True, capture_output=True)
    if proc.returncode != 0:
        print(proc.stdout)
        print(proc.stderr)
        return proc.returncode
    out = HERE / "out-selftest"
    train = [json.loads(l) for l in (out / "train.jsonl").read_text().splitlines() if l.strip()]
    val = [json.loads(l) for l in (out / "val.jsonl").read_text().splitlines() if l.strip()]
    def n(s):
        return " ".join(s.lower().split())
    assert not ({n(r["user"]) for r in train} & {n(r["user"]) for r in val})
    blob = "\n".join(r["user"] for r in train + val).lower()
    assert "capital of france" not in blob
    assert "as an ai language model" not in "\n".join(r["assistant"] for r in train + val).lower()
    files = Counter(r["source_file"] for r in train + val)
    assert not any("cnn" in k or "synthetic" in k or "unknown" in k for k in files)
    assert set(r["source_file"] for r in train) == set(r["source_file"] for r in val)
    dolly = files[[k for k in files if "dolly" in k][0]]
    assert dolly / max(1, len(train) + len(val)) <= 0.30
    licenses = {r["license"] for r in train + val}
    assert "CC-BY-SA-3.0" in licenses and "CC-BY-SA-4.0" in licenses and "MIT" in licenses
    assert all(r["revision"] == "UNKNOWN" for r in train)
    assert all(r["sharealike"] for r in train if r["license"].startswith("CC-BY-SA"))
    quality = json.loads((out / "quality.json").read_text())
    assert quality["gate"] == "ok"
    held = (HERE / "fixtures" / "general-v2.sha256").read_text().split()[0]
    assert held == "3c15169dfd848b57209b71813f75f972c74c35a0ce745c803376db33cb1323f9"
    assert "baseline_v2" not in (HERE / "build_balanced.py").read_text()
    cc = subprocess.run(
        ["cc", "-O2", "-std=c11", "-o", "/tmp/greedy_chat_pkg",
         str(HERE / "eval" / "greedy_chat.c"), str(HERE / "runtime" / "cipher.c"), "-lm", "-lpthread"],
        capture_output=True, text=True)
    assert cc.returncode == 0, cc.stderr
    print("package selftest ok", "train", len(train), "val", len(val), "dolly_share", round(dolly / (len(train)+len(val)), 3))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
