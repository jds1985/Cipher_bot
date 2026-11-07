#!/usr/bin/env python3
"""Stratified general mix from catalogued sources. Does not train.

Selection may read frozen prompt text only through the exclusion check.
It does not read baseline outputs or gold answers. CNN and uncatalogued
files are excluded. Licenses are copied from the catalog entry for that
source and are not merged or relabeled.

Supervised-token share, not row share, bounds each source. Every dropped
record is logged. A row moved from val to train is a move, not an exclusion.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import re
import subprocess
import sys
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "lib"))
from mix_rules import (  # noqa: E402
    LOSS_BALANCE_POLICY,
    UNCERTAINTY_SUPERVISION,
    apply_answer_policy,
    assistant_audit,
    cap_loss_tokens,
    clone_match,
    drop_val_substantial_overlap,
    load_frozen,
    loss_snapshot,
    norm,
    pin_unanswerable_to_train,
)
from pack_rows import CTX, pack_row, word_encode  # noqa: E402

GATE = HERE / "lib" / "sft_data_gate.py"
CATALOG = json.loads((HERE / "fixtures" / "sources_catalog.json").read_text(encoding="utf-8"))
PROBLEM = re.compile(
    r"as an ai language model|chatgpt|openai|claude|anthropic|\bjailbreak\b|front desk|call 911|on file for this hotel",
    re.I,
)
STAGES = ("load", "lexical", "user_dedup", "context", "answer_policy", "loss_token_cap", "val_overlap", "train_loss_cap")


def catalog_for(path: Path) -> dict | None:
    name = path.name.lower()
    if "cnn" in name or "synthetic" in name or name.startswith("math_"):
        return None
    for src in CATALOG["sources"]:
        if src["match"] in name:
            return src
    return None


def jsonl_records(path: Path):
    """Yield JSONL records split only on \\n. U+2028 and the other splitlines() separators stay inside strings."""
    text = path.read_bytes().decode("utf-8")
    if text.startswith("\ufeff"):
        text = text[1:]
    for line in text.split("\n"):
        if line.endswith("\r"):
            line = line[:-1]
        if line.strip():
            yield line


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def raw_count(path: Path) -> int:
    return sum(1 for _ in jsonl_records(path))


def exclusion(stage: str, reason: str, source_file: str, source_line: int, **extra) -> dict:
    record = {
        "kind": "filter",
        "stage": stage,
        "reason": reason,
        "source_file": source_file,
        "source_line": source_line,
    }
    record.update(extra)
    return record


def scan_file(path: Path, src: dict) -> tuple[int, list[dict], list[dict]]:
    rows, drops = [], []
    raw = 0
    for source_line, line in enumerate(jsonl_records(path), start=1):
        raw += 1
        try:
            obj = json.loads(line)
        except json.JSONDecodeError as exc:
            raise SystemExit(f"invalid_json {path.name} line {source_line}: {exc}") from exc
        msgs = obj.get("messages")
        if not isinstance(msgs, list):
            drops.append(exclusion("load", "not_messages", path.name, source_line))
            continue
        user = "\n".join(m.get("content", "") for m in msgs if isinstance(m, dict) and m.get("role") == "user").strip()
        assistant = "\n".join(m.get("content", "") for m in msgs if isinstance(m, dict) and m.get("role") == "assistant").strip()
        if len(user) < 12:
            reason = "user_too_short"
        elif len(assistant) < 1:
            reason = "empty_assistant"
        elif norm(user) == norm(assistant):
            reason = "user_equals_assistant"
        elif PROBLEM.search(user) or PROBLEM.search(assistant):
            reason = "problem_phrase"
        elif len(user) > 20000:
            reason = "user_too_long"
        elif len(assistant) > 8000:
            reason = "assistant_too_long"
        else:
            reason = ""
        if reason:
            drops.append(exclusion("load", reason, path.name, source_line))
            continue
        rows.append({
            "user": user,
            "assistant": assistant,
            "source_file": path.name,
            "source_line": source_line,
            "dataset_id": src["dataset_id"],
            "card_url": src["card_url"],
            "license": src["license"],
            "sharealike": src["sharealike"],
            "attribution": src["attribution"],
            "revision": "UNKNOWN",
            "domain": src["domain"],
            "weights_clearance": "unresolved" if src["sharealike"] else "dataset card allows dataset use; weights not cleared",
        })
    return raw, rows, drops


def dedup_rows(rows: list[dict]) -> tuple[list[dict], list[dict]]:
    seen = set()
    kept, drops = [], []
    for row in rows:
        key = norm(row["user"])
        if key in seen:
            drops.append(exclusion("user_dedup", "duplicate_user", row["source_file"], row["source_line"]))
            continue
        seen.add(key)
        kept.append(row)
    return kept, drops


def fit_rows(rows: list[dict], encode) -> tuple[list[dict], list[dict]]:
    kept, drops = [], []
    for row in rows:
        packed = pack_row(encode, row, CTX)
        row["prompt_tokens"] = packed["prompt_tokens"]
        row["answer_tokens"] = packed["answer_tokens"]
        row["loss_tokens"] = packed["answer_tokens"] + 1
        if packed["status"] != "ok":
            drops.append(exclusion(
                "context", packed["reason"], row["source_file"], row["source_line"],
                prompt_tokens=packed["prompt_tokens"], answer_tokens=packed["answer_tokens"],
                ctx=CTX, loss_tokens=row["loss_tokens"],
            ))
            continue
        kept.append(row)
    return kept, drops


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


def stage_view(file_meta: dict, drops: list[dict], train: list[dict], val: list[dict]) -> dict:
    by_drop = defaultdict(lambda: defaultdict(Counter))
    for item in drops:
        by_drop[item["source_file"]][item["stage"]][item["reason"]] += 1
    train_n = Counter(row["source_file"] for row in train)
    val_n = Counter(row["source_file"] for row in val)
    by_source = {}
    problems = []
    for name, meta in sorted(file_meta.items()):
        stages = []
        remaining = meta["raw_records"]
        for stage in STAGES:
            reasons = dict(by_drop[name].get(stage, {}))
            dropped = sum(reasons.values())
            remaining -= dropped
            stages.append({"stage": stage, "excluded": reasons, "excluded_rows": dropped, "retained": remaining})
        retained = train_n[name] + val_n[name]
        if remaining != retained or meta["raw_records"] != retained + sum(
            sum(by_drop[name].get(stage, {}).values()) for stage in STAGES
        ):
            problems.append(name)
        by_source[name] = {
            "sha256": meta["sha256"],
            "raw_records": meta["raw_records"],
            "stages": stages,
            "train": train_n[name],
            "val": val_n[name],
            "retained": retained,
        }
    raw = sum(meta["raw_records"] for meta in file_meta.values())
    identity_ok = not problems and raw == len(drops) + len(train) + len(val)
    keys = [(item["source_file"], item["source_line"]) for item in drops]
    keys += [(row["source_file"], row["source_line"]) for row in train + val]
    if len(keys) != len(set(keys)):
        identity_ok = False
        problems.append("duplicate_source_line")
    return {
        "identity_ok": identity_ok,
        "check": "raw_records = excluded_rows + train_rows + val_rows",
        "raw_records": raw,
        "excluded_rows": len(drops),
        "train_rows": len(train),
        "val_rows": len(val),
        "problems": problems,
        "excluded_reasons": dict(Counter(item["reason"] for item in drops)),
        "by_source": by_source,
    }


def quality(train: list[dict], val: list[dict]) -> dict:
    def side(rows):
        by = defaultdict(int)
        lic = defaultdict(lambda: defaultdict(int))
        loss = defaultdict(int)
        for row in rows:
            by[row["source_file"]] += 1
            lic[row["license"]][row["source_file"]] += 1
            loss[row["source_file"]] += int(row.get("loss_tokens") or 0)
        return {
            "rows": len(rows),
            "by_file": dict(by),
            "loss_tokens_by_file": dict(loss),
            "licenses_by_source": {key: dict(value) for key, value in lic.items()},
        }
    users_tr = {norm(row["user"]) for row in train}
    users_va = {norm(row["user"]) for row in val}
    return {
        "gate": "pending",
        "train": side(train),
        "val": side(val),
        "train_val_user_overlap": len(users_tr & users_va),
        "revision": "UNKNOWN",
        "weights_clearance": "unresolved for CC-BY-SA rows; not a commercial clearance",
        "excluded": ["cnn_dailymail", "synthetic", "uncatalogued"],
    }


def uncertainty_report(rows: list[dict]) -> dict:
    squad = [row for row in rows if "squad" in row["source_file"]]
    kept = [row for row in squad if norm(row["assistant"]) in {
        "the text doesn't say.",
        "the passage doesn't contain the answer to that.",
        "i can't tell from the text.",
    }]
    return {
        "statement": UNCERTAINTY_SUPERVISION,
        "squad_rows_retained": len(squad),
        "unanswerable_rows_retained": len(kept),
        "share_of_retained_squad": round(len(kept) / len(squad), 6) if squad else 0.0,
        "templates_rewritten": False,
    }


def make_encode(args):
    if args.word_tokens:
        return word_encode, "word_fixture", "word_fixture"
    if args.tokenizer and args.tokenizer.is_file():
        from tokenizers import Tokenizer
        tok = Tokenizer.from_file(str(args.tokenizer))
        return (lambda text: tok.encode(text, add_special_tokens=False).ids), "huggingface", sha256_file(args.tokenizer)
    print("tokenizer_required")
    return None, "", ""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sources", type=Path)
    ap.add_argument("--out", type=Path, default=HERE / "out")
    ap.add_argument("--tokenizer", type=Path)
    ap.add_argument("--word-tokens", action="store_true")
    ap.add_argument("--per-source", type=int, default=None)
    ap.add_argument("--max-share", type=float, default=None)
    ap.add_argument("--math-fraction", type=float, default=None)
    ap.add_argument("--seed", type=int, default=20261107)
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    if args.self_test:
        args.sources = HERE / "fixtures" / "adversarial"
        args.out = HERE / "out-selftest"
        args.word_tokens = True
    if args.sources is None or not args.sources.is_dir():
        print("sources_missing")
        return 2
    encode, tokenizer_mode, tokenizer_sha = make_encode(args)
    if encode is None:
        return 2
    held = (HERE / "fixtures" / "general-v2.sha256").read_text().split()[0]
    got = hashlib.sha256((HERE / "fixtures" / "general-v2.json").read_bytes()).hexdigest()
    if got != held:
        print("heldout_changed")
        return 2
    frozen = load_frozen([HERE / "fixtures" / "general-v1.json", HERE / "fixtures" / "general-v2.json"])
    file_meta = {}
    skipped = []
    drops = []
    loaded = []
    for path in sorted(args.sources.glob("*.jsonl")):
        src = catalog_for(path)
        digest = sha256_file(path)
        if src is None:
            skipped.append({"file": path.name, "sha256": digest, "raw_records": raw_count(path)})
            continue
        raw, rows, load_drops = scan_file(path, src)
        file_meta[path.name] = {"sha256": digest, "raw_records": raw}
        drops.extend(load_drops)
        loaded.extend(rows)
    lexical = []
    survivors = []
    for row in loaded:
        hit = clone_match(row["user"], frozen)
        if hit:
            lexical.append({
                "kind": "lexical_clone",
                "stage": "lexical",
                "reason": hit["reason"],
                "source_file": row["source_file"],
                "source_line": row["source_line"],
                "matched_frozen_id": hit["matched_frozen_id"],
                "matched_frozen_file": hit["matched_frozen_file"],
                "similarity": hit["similarity"],
            })
            continue
        survivors.append(row)
    drops.extend(lexical)
    survivors, dedup_drops = dedup_rows(survivors)
    drops.extend(dedup_drops)
    survivors, fit_drops = fit_rows(survivors, encode)
    drops.extend(fit_drops)
    entering_answer_policy = len(survivors)
    survivors, answer_drops, answer_impact = apply_answer_policy(survivors)
    for item in answer_drops:
        item["stage"] = "answer_policy"
        item["kind"] = "filter"
    drops.extend(answer_drops)
    before_loss = loss_snapshot(survivors)
    survivors, loss_drops, loss_report = cap_loss_tokens(survivors, args.seed)
    if loss_report["unresolved_sources"]:
        print("loss_share_unresolved", " ".join(loss_report["unresolved_sources"]))
        return 2
    for item in loss_drops:
        item["stage"] = "loss_token_cap"
    drops.extend(loss_drops)
    after_loss = loss_report["after"]
    train, val = assign_split(survivors, args.seed)
    train, val, pinned = pin_unanswerable_to_train(train, val)
    val, val_dropped = drop_val_substantial_overlap(train, val)
    for item in val_dropped:
        item["stage"] = "val_overlap"
        item["kind"] = "filter"
    drops.extend(val_dropped)
    train_before_cap = loss_snapshot(train)
    train, train_cap_drops, train_cap_report = cap_loss_tokens(train, args.seed)
    if train_cap_report["unresolved_sources"]:
        print("train_loss_share_unresolved", " ".join(train_cap_report["unresolved_sources"]))
        return 2
    for item in train_cap_drops:
        item["stage"] = "train_loss_cap"
        item["reason"] = "train_loss_share"
    drops.extend(train_cap_drops)
    train.sort(key=lambda row: (row["source_file"], row["source_line"]))
    val.sort(key=lambda row: (row["source_file"], row["source_line"]))
    drops.sort(key=lambda item: (item.get("source_file") or "", item.get("source_line") or 0, item.get("reason") or ""))
    reconcile = stage_view(file_meta, drops, train, val)
    reconcile["pinned_moves"] = len(pinned)
    reconcile["pinned_counted_as_exclusions"] = False
    reconcile["entering_answer_policy"] = entering_answer_policy
    reconcile["tokenizer_mode"] = tokenizer_mode
    reconcile["tokenizer_sha256"] = tokenizer_sha
    reconcile["loss_balance_policy"] = LOSS_BALANCE_POLICY
    if any(item.get("reason") == "pinned_unanswerable_to_train" for item in drops):
        reconcile["identity_ok"] = False
        reconcile["problems"].append("pinned_row_logged_as_exclusion")
    if not reconcile["identity_ok"]:
        print("reconcile_fail", reconcile["problems"])
        return 2
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "exclusions.jsonl").write_text(
        "".join(json.dumps(item, ensure_ascii=False) + "\n" for item in drops), encoding="utf-8")
    for name, rows in (("train", train), ("val", val)):
        (args.out / f"{name}.jsonl").write_text(
            "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")
    report = quality(train, val)
    report["skipped_files"] = skipped
    report["dropped_near_clone"] = len(lexical)
    report["answer_policy"] = answer_impact
    report["loss_tokens_before_cap"] = before_loss
    report["loss_tokens_after_cap"] = after_loss
    report["loss_tokens_train_before_post_split_cap"] = train_before_cap
    report["loss_tokens_train"] = loss_snapshot(train)
    report["train_loss_cap"] = train_cap_report
    report["loss_balance"] = loss_report
    report["row_share_cap"] = "not applied"
    report["math_row_fraction"] = "not applied"
    report["ignored_row_limits"] = {
        "per_source": args.per_source,
        "max_share": args.max_share,
        "math_fraction": args.math_fraction,
    }
    report["moves"] = pinned
    report["unanswerable_pinned_to_train"] = len(pinned)
    report["uncertainty_supervision"] = uncertainty_report(train + val)
    report["assistant_audit"] = assistant_audit(train, val)[0]
    report["heldout_sha256"] = held
    report["seed"] = args.seed
    report["fixture_selftest_is_not_real_data"] = bool(args.self_test or args.word_tokens)
    report["tokenizer_mode"] = tokenizer_mode
    report["reconcile"] = reconcile
    report["planned_steps"] = None
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
    (args.out / "reconcile.json").write_text(json.dumps(reconcile, indent=2) + "\n", encoding="utf-8")
    print(proc.stdout)
    print("quality_gate", report["gate"])
    print(
        "reconcile", reconcile["raw_records"], "excluded", reconcile["excluded_rows"],
        "train", reconcile["train_rows"], "val", reconcile["val_rows"],
    )
    return 0 if report["gate"] == "ok" else 2


if __name__ == "__main__":
    sys.exit(main())
