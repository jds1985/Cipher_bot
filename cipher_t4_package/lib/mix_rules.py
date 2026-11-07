"""Shared row rules for the builder and the gate.

Import these functions from both sides. A second copy of the clone check
or the answer classes will let rows through one and fail the other.
"""

from __future__ import annotations

import json
import re
from collections import Counter, defaultdict
from pathlib import Path

# The gate's stop list. It is stricter than the builder's old list on the
# rows that previously survived into the gate: dropping "dollar", "translate",
# and the other instruction words raises Jaccard above 0.5. Do not shrink it.
STOP = {
    "a", "an", "the", "of", "to", "and", "in", "on", "is", "are", "was", "were", "be",
    "what", "how", "many", "which", "who", "when", "where", "why", "do", "does", "did",
    "this", "that", "these", "those", "into", "only", "just", "for", "with", "from", "by",
    "or", "if", "you", "your", "it", "its", "at", "as", "than", "then", "so", "not", "no",
    "can", "cannot", "know", "say", "have", "has", "about", "there", "all", "every",
    "use", "using", "read", "paragraph", "question", "write", "tell", "short", "clean",
    "explain", "sentence", "sentences", "answer", "reply", "exactly", "nothing", "else",
    "words", "word", "list", "separated", "commas", "translate", "english", "phrase",
    "translation", "should", "receive", "pay", "cost", "costs", "dollar", "dollars",
    "bill", "together", "more", "less",
}

# Exact assistant strings written by the v3 SQuAD converter. No paraphrases.
UNANSWERABLE_TEMPLATES = (
    "the text doesn't say.",
    "the passage doesn't contain the answer to that.",
    "i can't tell from the text.",
)
PER_TEMPLATE_CAP = 4
# Of the source's rows at the start of answer policy, before the split.
UNANSWERABLE_RATIO_MAX = 0.02
# A short fact may recur. A refusal template may not use this exception.
SHORT_ANSWER_MAX_TOKENS = 3
SHORT_ANSWER_MAX_CHARS = 32
SHORT_ANSWER_CAP = 8
SUBSTANTIAL_ANSWER_CAP = 1

REFUSAL = re.compile(
    r"doesn'?t say|does not say|can'?t tell|cannot tell|don'?t know|do not know|"
    r"doesn'?t contain|does not contain|not contain the answer|unanswerable|"
    r"cannot be answered|can'?t be answered|no answer|i refuse",
    re.I,
)
REASON_RANK = {"exact_norm": 4, "substring": 3, "containment": 2, "jaccard": 1}


def norm(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip().lower())


def content_tokens(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9]+", text.lower()) if w not in STOP}


def jaccard(a: set[str], b: set[str]) -> float:
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def is_unanswerable_template(assistant: str) -> bool:
    return norm(assistant) in UNANSWERABLE_TEMPLATES


def is_short_answer(assistant: str) -> bool:
    """Documented exception: a short fact, not a refusal template."""
    text = norm(assistant)
    if not text or is_unanswerable_template(assistant) or REFUSAL.search(text):
        return False
    if len(text) > SHORT_ANSWER_MAX_CHARS:
        return False
    return len(text.split()) <= SHORT_ANSWER_MAX_TOKENS


def answer_class(assistant: str) -> str:
    if is_unanswerable_template(assistant):
        return "unanswerable_template"
    if is_short_answer(assistant):
        return "short_exception"
    return "substantial"


def load_frozen(paths: list[Path]) -> list[dict]:
    found = []
    for path in paths:
        doc = json.loads(path.read_text(encoding="utf-8"))
        prompts = []
        if isinstance(doc, dict) and isinstance(doc.get("prompts"), list):
            prompts = doc["prompts"]
        elif isinstance(doc, dict) and isinstance(doc.get("probes"), list):
            prompts = doc["probes"]
        elif isinstance(doc, list):
            prompts = doc
        else:
            raise SystemExit(f"{path} is not a prompt list")
        for index, row in enumerate(prompts, start=1):
            if isinstance(row, str):
                text, ident = row, f"line-{index}"
            elif isinstance(row, dict) and isinstance(row.get("text"), str):
                text, ident = row["text"], str(row.get("id") or f"line-{index}")
            elif isinstance(row, dict) and isinstance(row.get("user"), str):
                text, ident = row["user"], str(row.get("id") or f"line-{index}")
            else:
                continue
            found.append({
                "id": ident,
                "file": path.name,
                "norm": norm(text),
                "tokens": content_tokens(text),
            })
    return found


def clone_match(user: str, frozen: list[dict]) -> dict | None:
    """Best lexical or exact match. The result has ids, a reason, and a score. No prompt text."""
    user_norm = norm(user)
    got = content_tokens(user)
    best = None
    best_key = None
    for entry in frozen:
        reasons = []
        if user_norm == entry["norm"]:
            reasons.append(("exact_norm", 1.0))
        if len(user_norm) > 20 and entry["norm"] and (user_norm in entry["norm"] or entry["norm"] in user_norm):
            short, long = sorted((len(user_norm), len(entry["norm"])))
            reasons.append(("substring", short / long if long else 1.0))
        score = jaccard(got, entry["tokens"])
        if score >= 0.5:
            reasons.append(("jaccard", score))
        small = min(len(got), len(entry["tokens"]))
        if small >= 4:
            cover = len(got & entry["tokens"]) / small
            if cover >= 0.8:
                reasons.append(("containment", cover))
        if not reasons:
            continue
        reason, similarity = max(reasons, key=lambda item: (item[1], REASON_RANK[item[0]]))
        cand = {
            "matched_frozen_id": entry["id"],
            "matched_frozen_file": entry["file"],
            "reason": reason,
            "similarity": round(similarity, 6),
        }
        key = (cand["similarity"], REASON_RANK[reason], entry["file"], entry["id"])
        if best_key is None or key > best_key:
            best, best_key = cand, key
    return best


def _drop(row: dict, reason: str) -> dict:
    return {
        "kind": "answer_policy",
        "reason": reason,
        "source_file": row.get("source_file"),
        "source_line": row.get("source_line"),
        "assistant_norm": norm(row.get("assistant", "")),
        "answer_class": answer_class(row.get("assistant", "")),
    }


def apply_answer_policy(rows: list[dict]) -> tuple[list[dict], list[dict], dict]:
    """Cap refusal templates and repeated answers before any split.

    Unanswerable templates keep at most PER_TEMPLATE_CAP copies, and at most
    UNANSWERABLE_RATIO_MAX of each source, with one copy of each observed
    template retained when that ratio would erase them. Short facts keep at
    most SHORT_ANSWER_CAP. Every other answer keeps one copy. Order is
    source file, then source line. No new answer text is written.
    """
    exclusions: list[dict] = []
    by_source: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        by_source[row.get("source_file") or ""].append(row)

    global_templates: list[dict] = []
    others: list[dict] = []
    per_source_meta = {}
    for source, group in by_source.items():
        ordered = sorted(group, key=lambda r: (r.get("source_line") or 0, source))
        templates = [r for r in ordered if is_unanswerable_template(r["assistant"])]
        plain = [r for r in ordered if not is_unanswerable_template(r["assistant"])]
        before = Counter(norm(r["assistant"]) for r in templates)
        capped: list[dict] = []
        seen: Counter[str] = Counter()
        for row in templates:
            key = norm(row["assistant"])
            if seen[key] >= PER_TEMPLATE_CAP:
                exclusions.append(_drop(row, "unanswerable_template_cap"))
                continue
            seen[key] += 1
            capped.append(row)
        observed = len(before)
        budget = int(len(group) * UNANSWERABLE_RATIO_MAX)
        floor = False
        if observed and budget < observed:
            budget = observed
            floor = True
        while len(capped) > budget:
            counts = Counter(norm(r["assistant"]) for r in capped)
            multi = {key for key, count in counts.items() if count > 1}
            if not multi:
                break
            index = max(i for i, row in enumerate(capped) if norm(row["assistant"]) in multi)
            exclusions.append(_drop(capped[index], "unanswerable_ratio"))
            del capped[index]
        global_templates.extend(capped)
        others.extend(plain)
        per_source_meta[source] = {
            "rows_entering": len(group),
            "unanswerable_before": dict(before),
            "budget": budget,
            "ratio_max": UNANSWERABLE_RATIO_MAX,
            "ratio_floor_one_per_observed_template": floor,
            "unanswerable_after_source_policy": dict(Counter(norm(r["assistant"]) for r in capped)),
        }

    # A template that appears in more than one file still has one global cap.
    templates_kept: list[dict] = []
    seen = Counter()
    for row in sorted(global_templates, key=lambda r: (r.get("source_file") or "", r.get("source_line") or 0)):
        key = norm(row["assistant"])
        if seen[key] >= PER_TEMPLATE_CAP:
            exclusions.append(_drop(row, "unanswerable_template_cap"))
            continue
        seen[key] += 1
        templates_kept.append(row)

    buckets: dict[str, list[dict]] = defaultdict(list)
    for row in sorted(others, key=lambda r: (r.get("source_file") or "", r.get("source_line") or 0)):
        buckets[norm(row["assistant"])].append(row)
    kept = list(templates_kept)
    short_dropped = 0
    substantial_dropped = 0
    for key, group in buckets.items():
        kind = answer_class(group[0]["assistant"])
        cap = SHORT_ANSWER_CAP if kind == "short_exception" else SUBSTANTIAL_ANSWER_CAP
        kept.extend(group[:cap])
        for row in group[cap:]:
            reason = "short_answer_cap" if kind == "short_exception" else "substantial_answer_repeat"
            exclusions.append(_drop(row, reason))
            if kind == "short_exception":
                short_dropped += 1
            else:
                substantial_dropped += 1
    impact = {
        "per_template_cap": PER_TEMPLATE_CAP,
        "unanswerable_ratio_max": UNANSWERABLE_RATIO_MAX,
        "short_answer_cap": SHORT_ANSWER_CAP,
        "substantial_answer_cap": SUBSTANTIAL_ANSWER_CAP,
        "short_answer_rule": (
            f"at most {SHORT_ANSWER_MAX_TOKENS} tokens and {SHORT_ANSWER_MAX_CHARS} characters, "
            "not an unanswerable template and not a refusal"
        ),
        "by_source": per_source_meta,
        "unanswerable_kept": dict(Counter(norm(r["assistant"]) for r in templates_kept)),
        "short_dropped": short_dropped,
        "substantial_dropped": substantial_dropped,
        "excluded_rows": len(exclusions),
    }
    return kept, exclusions, impact


def pin_unanswerable_to_train(train: list[dict], val: list[dict]) -> tuple[list[dict], list[dict], list[dict]]:
    """Refusal templates stay in train so a long repeated answer cannot cross the split."""
    pinned = [row for row in val if is_unanswerable_template(row["assistant"])]
    if not pinned:
        return train, val, []
    val = [row for row in val if not is_unanswerable_template(row["assistant"])]
    notes = [_drop(row, "pinned_unanswerable_to_train") for row in pinned]
    return train + pinned, val, notes


def drop_val_substantial_overlap(train: list[dict], val: list[dict]) -> tuple[list[dict], list[dict]]:
    """Remove val rows that reuse a train answer, except documented short facts."""
    train_answers = {norm(row["assistant"]) for row in train}
    kept, dropped = [], []
    for row in val:
        key = norm(row["assistant"])
        if key in train_answers and not is_short_answer(row["assistant"]):
            dropped.append(_drop(row, "val_shares_substantial_answer"))
            continue
        kept.append(row)
    return kept, dropped


def assistant_audit(train: list[dict], val: list[dict], max_substantial_repeat: int = SUBSTANTIAL_ANSWER_CAP) -> tuple[dict, list[str]]:
    """Unique-string counts and row counts. Short facts are listed, not hidden."""
    tr = Counter(norm(row["assistant"]) for row in train)
    va = Counter(norm(row["assistant"]) for row in val)
    shared_keys = sorted(set(tr) & set(va))
    shared = []
    for key in shared_keys:
        shared.append({
            "assistant_norm": key,
            "answer_class": answer_class(key),
            "train_rows": tr[key],
            "val_rows": va[key],
            "rows": tr[key] + va[key],
        })
    problems = []
    combined = tr + va
    for key, count in sorted(combined.items()):
        kind = answer_class(key)
        in_both = key in tr and key in va
        if kind == "unanswerable_template":
            if count > PER_TEMPLATE_CAP:
                problems.append(f"unanswerable template {key!r} appears {count} times, cap is {PER_TEMPLATE_CAP}")
            if in_both:
                problems.append(f"unanswerable template {key!r} is in train and val")
        elif kind == "short_exception":
            if count > SHORT_ANSWER_CAP:
                problems.append(f"short answer {key!r} appears {count} times, cap is {SHORT_ANSWER_CAP}")
        else:
            if count > max_substantial_repeat:
                problems.append(f"substantial answer appears {count} times")
            if in_both:
                problems.append("a substantial answer is in train and val")
    recurring_short = [
        {"assistant_norm": key, "train_rows": tr[key], "val_rows": va[key], "rows": combined[key]}
        for key, count in sorted(combined.items())
        if answer_class(key) == "short_exception" and (count > 1 or (key in tr and key in va))
    ]
    report = {
        "unique_train": len(tr),
        "unique_val": len(va),
        "unique_shared": len(shared_keys),
        "shared_rows_train": sum(tr[key] for key in shared_keys),
        "shared_rows_val": sum(va[key] for key in shared_keys),
        "shared": shared,
        "short_answer_exceptions": recurring_short,
        "max_assistant_repeat": max(combined.values()) if combined else 0,
    }
    return report, problems
