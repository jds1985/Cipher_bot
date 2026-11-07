#!/usr/bin/env python3
"""Stratified general mix from catalogued sources. Does not train.

Selection may read frozen prompt text only through the exclusion check.
It does not read baseline outputs or gold answers. CNN and uncatalogued
files are excluded. Licenses are copied from the catalog entry for that
source and are not merged or relabeled.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
GATE = HERE / "lib" / "sft_data_gate.py"
CATALOG = json.loads((HERE / "fixtures" / "sources_catalog.json").read_text(encoding="utf-8"))
STOP = {
    "a", "an", "the", "of", "to", "and", "in", "on", "is", "are", "was", "were", "be",
    "what", "how", "many", "which", "who", "when", "where", "why", "do", "does", "did",
    "this", "that", "these", "those", "into", "only", "just", "for", "with", "from", "by",
    "or", "if", "you", "your", "it", "its", "at", "as", "than", "then", "so", "not", "no",
    "can", "cannot", "know", "say", "have", "has", "about", "there", "all", "every",
    "use", "using", "read", "paragraph", "question", "write", "tell", "short", "clean",
    "explain", "sentence", "sentences", "answer", "reply", "exactly", "nothing", "else",
}
PROBLEM = re.compile(
    r"as an ai language model|chatgpt|openai|claude|anthropic|\bjailbreak\b|front desk|call 911|on file for this hotel",
    re.I,
)


def norm(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip().lower())


def tokens(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9]+", text.lower()) if w not in STOP}


def jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def near_clone(user: str, frozen: list[tuple[str, set[str]]]) -> bool:
    n = norm(user)
    got = tokens(user)
    for raw, fr in frozen:
        if n == norm(raw):
            return True
        if len(n) > 20 and (n in norm(raw) or norm(raw) in n):
            return True
        if jaccard(got, fr) >= 0.5:
            return True
        small = min(len(got), len(fr))
        if small >= 4 and len(got & fr) / small >= 0.8:
            return True
    return False


def catalog_for(path: Path) -> dict | None:
    name = path.name.lower()
    if "cnn" in name or "synthetic" in name or name.startswith("math_"):
        return None
    for src in CATALOG["sources"]:
        if src["match"] in name:
            return src
    return None


def load_file(path: Path, src: dict, cap: int) -> list[dict]:
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        obj = json.loads(line)
        msgs = obj.get("messages")
        if not isinstance(msgs, list):
            continue
        user = "\n".join(m.get("content", "") for m in msgs if isinstance(m, dict) and m.get("role") == "user").strip()
        assistant = "\n".join(m.get("content", "") for m in msgs if isinstance(m, dict) and m.get("role") == "assistant").strip()
        if len(user) < 12 or len(assistant) < 1 or norm(user) == norm(assistant):
            continue
        if PROBLEM.search(user) or PROBLEM.search(assistant):
            continue
        if len(user) > 20000 or len(assistant) > 8000:
            continue
        rows.append({
            "user": user,
            "assistant": assistant,
            "source_file": path.name,
            "dataset_id": src["dataset_id"],
            "card_url": src["card_url"],
            "license": src["license"],
            "sharealike": src["sharealike"],
            "attribution": src["attribution"],
            "revision": "UNKNOWN",
            "domain": src["domain"],
            "weights_clearance": "unresolved" if src["sharealike"] else "dataset card allows dataset use; weights not cleared",
        })
        if len(rows) >= cap:
            break
    return rows


def dedup(rows: list[dict]) -> list[dict]:
    seen = set()
    out = []
    for row in rows:
        key = norm(row["user"])
        if key in seen:
            continue
        seen.add(key)
        out.append(row)
    return out


def assign_split(rows: list[dict], seed: int) -> tuple[list[dict], list[dict]]:
    by_source = defaultdict(list)
    for row in rows:
        by_source[row["source_file"]].append(row)
    train, val = [], []
    for source, group in by_source.items():
        rng = random.Random(f"{seed}|{source}")
        rng.shuffle(group)
        if len(group) == 1:
            train.extend(group)
            continue
        n_val = max(1, len(group) // 10)
        val.extend(group[:n_val])
        train.extend(group[n_val:])
    return train, val


def cap_share(rows: list[dict], max_share: float, seed: int) -> list[dict]:
    grouped = defaultdict(list)
    for row in rows:
        grouped[row["source_file"]].append(row)
    rng = random.Random(seed)
    for _ in range(6):
        total = sum(len(group) for group in grouped.values())
        if total == 0:
            return []
        limit = max(1, int(total * max_share))
        changed = False
        for source, group in list(grouped.items()):
            if len(group) > limit:
                rng.shuffle(group)
                grouped[source] = group[:limit]
                changed = True
        if not changed:
            break
    out = []
    for group in grouped.values():
        out.extend(group)
    return out


def frozen_pairs() -> list[tuple[str, set[str]]]:
    pairs = []
    for name in ("general-v1.json", "general-v2.json"):
        doc = json.loads((HERE / "fixtures" / name).read_text(encoding="utf-8"))
        for prompt in doc["prompts"]:
            text = prompt["text"]
            pairs.append((text, tokens(text)))
    return pairs


def quality(train: list[dict], val: list[dict]) -> dict:
    def side(rows):
        by = defaultdict(int)
        lic = defaultdict(lambda: defaultdict(int))
        for row in rows:
            by[row["source_file"]] += 1
            lic[row["license"]][row["source_file"]] += 1
        return {"rows": len(rows), "by_file": dict(by), "licenses_by_source": {k: dict(v) for k, v in lic.items()}}
    users_tr = {norm(r["user"]) for r in train}
    users_va = {norm(r["user"]) for r in val}
    return {
        "gate": "pending",
        "train": side(train),
        "val": side(val),
        "train_val_user_overlap": len(users_tr & users_va),
        "revision": "UNKNOWN",
        "weights_clearance": "unresolved for CC-BY-SA rows; not a commercial clearance",
        "excluded": ["cnn_dailymail", "synthetic", "uncatalogued"],
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sources", type=Path)
    ap.add_argument("--out", type=Path, default=HERE / "out")
    ap.add_argument("--per-source", type=int, default=2000)
    ap.add_argument("--max-share", type=float, default=0.30)
    ap.add_argument("--math-fraction", type=float, default=0.25)
    ap.add_argument("--seed", type=int, default=20261107)
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    if args.self_test:
        args.sources = HERE / "fixtures" / "adversarial"
        args.out = HERE / "out-selftest"
        args.per_source = 100
        args.max_share = 0.30
    if args.sources is None or not args.sources.is_dir():
        print("sources_missing")
        return 2
    held = (HERE / "fixtures" / "general-v2.sha256").read_text().split()[0]
    got = hashlib.sha256((HERE / "fixtures" / "general-v2.json").read_bytes()).hexdigest()
    if got != held:
        print("heldout_changed")
        return 2
    frozen = frozen_pairs()
    kept = []
    skipped = []
    dropped_clone = 0
    for path in sorted(args.sources.glob("*.jsonl")):
        src = catalog_for(path)
        if src is None:
            skipped.append(path.name)
            continue
        rows = load_file(path, src, args.per_source * 5)
        before = len(rows)
        rows = [r for r in rows if not near_clone(r["user"], frozen)]
        dropped_clone += before - len(rows)
        kept.extend(rows[: args.per_source * 5])
    kept = dedup(kept)
    human = [r for r in kept if r["domain"] == "human_general"]
    math = [r for r in kept if r["domain"] == "math"]
    human = cap_share(human, args.max_share, args.seed)
    math_cap = int(len(human) * args.math_fraction)
    rng = random.Random(args.seed)
    rng.shuffle(math)
    math = math[:max(0, math_cap)]
    train, val = assign_split(human + math, args.seed)
    args.out.mkdir(parents=True, exist_ok=True)
    for name, rows in (("train", train), ("val", val)):
        (args.out / f"{name}.jsonl").write_text(
            "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")
    report = quality(train, val)
    report["skipped_files"] = skipped
    report["dropped_near_clone"] = dropped_clone
    report["heldout_sha256"] = held
    report["seed"] = args.seed
    proc = subprocess.run(
        [sys.executable, str(GATE), "--train", str(args.out / "train.jsonl"), "--val", str(args.out / "val.jsonl"),
         "--frozen", str(HERE / "fixtures" / "general-v1.json"),
         "--frozen", str(HERE / "fixtures" / "general-v2.json"),
         "--lexical-jaccard", "0.5",
         "--max-assistant-repeat", "1",
         "--ban", "front desk", "--ban", "call 911"],
        text=True, capture_output=True)
    report["gate_stdout"] = proc.stdout
    report["gate"] = "ok" if proc.returncode == 0 and report["train_val_user_overlap"] == 0 else "fail"
    sources_in_train = set(report["train"]["by_file"])
    sources_in_val = set(report["val"]["by_file"])
    if sources_in_train - sources_in_val:
        report["gate"] = "fail"
        report["val_missing_sources"] = sorted(sources_in_train - sources_in_val)
    (args.out / "quality.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(proc.stdout)
    print("quality_gate", report["gate"])
    print("skipped", len(skipped), "dropped_near_clone", dropped_clone)
    return 0 if report["gate"] == "ok" else 2


if __name__ == "__main__":
    sys.exit(main())
