"""Shared row rules for the builder and the gate.

Import these functions from both sides. A second copy of the clone check
or the answer classes will let rows through one and fail the other.
"""

from __future__ import annotations

import hashlib
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
    notes = []
    for row in pinned:
        note = _drop(row, "pinned_unanswerable_to_train")
        note["kind"] = "move"
        notes.append(note)
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


# One source may not exceed this share of assistant+EOT tokens.
# 40% keeps a source from becoming the majority of the loss after the v4 mix
# put OASST at 65% of supervised tokens with only about a quarter of the rows.
# It is not a value selected by running the fixture.
LOSS_SHARE_NUMERATOR = 40
LOSS_SHARE_DENOMINATOR = 100
MAX_LOSS_SHARE = LOSS_SHARE_NUMERATOR / LOSS_SHARE_DENOMINATOR
LOSS_BALANCE_POLICY = (
    "The training loss averages assistant tokens and the end-of-turn token, so row share is not loss share. "
    "After the quality filters, any source above 40% of those tokens is reduced by whole rows in sha256(seed, file, line) order. "
    "A row is kept when its own tokens still fit in that source's budget. Sources already at or under 40% are not reduced. "
    "Answers are not shortened, and rows are not dropped for being long or short. "
    "The previous 30% row cap and 25% math row cap are not applied."
)
UNCERTAINTY_SUPERVISION = (
    "Unanswerable SQuAD rows keep the original three assistant strings, at most 4 copies each and at most 2% of that source. "
    "The strings are not rewritten. This is a small residual of that source, not a general-uncertainty curriculum, "
    "and it is not expanded to make the gate look more balanced."
)


def loss_rank(seed: int, row: dict) -> int:
    payload = f"{seed}|loss|{row.get('source_file')}|{row.get('source_line')}".encode()
    return int.from_bytes(hashlib.sha256(payload).digest()[:8], "big")


def loss_snapshot(rows: list[dict]) -> dict:
    by = defaultdict(lambda: {"rows": 0, "loss_tokens": 0})
    for row in rows:
        slot = by[row.get("source_file") or ""]
        slot["rows"] += 1
        slot["loss_tokens"] += int(row.get("loss_tokens") or 0)
    total = sum(slot["loss_tokens"] for slot in by.values())
    out = {}
    for source, slot in sorted(by.items()):
        slot["share"] = round(slot["loss_tokens"] / total, 6) if total else 0.0
        out[source] = dict(slot)
    return {"total_loss_tokens": total, "total_rows": len(rows), "by_source": out}


def cap_loss_tokens(rows: list[dict], seed: int, max_share: float = MAX_LOSS_SHARE) -> tuple[list[dict], list[dict], dict]:
    """Drop whole rows until every source is at most max_share of supervised tokens."""
    groups: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        if "loss_tokens" not in row:
            raise SystemExit("loss_tokens missing before the token cap")
        groups[row.get("source_file") or ""].append(row)
    for group in groups.values():
        group.sort(key=lambda row: loss_rank(seed, row))
    dropped: list[dict] = []
    minimum_row = False
    for _ in range(32):
        total = sum(row["loss_tokens"] for group in groups.values() for row in group)
        changed = False
        for source in sorted(groups):
            group = groups[source]
            src_tokens = sum(row["loss_tokens"] for row in group)
            if total <= 0 or src_tokens * LOSS_SHARE_DENOMINATOR <= total * LOSS_SHARE_NUMERATOR:
                continue
            rest = total - src_tokens
            max_keep = (rest * LOSS_SHARE_NUMERATOR) // (LOSS_SHARE_DENOMINATOR - LOSS_SHARE_NUMERATOR)
            kept: list[dict] = []
            used = 0
            stage_dropped: list[dict] = []
            for row in group:
                if used + row["loss_tokens"] <= max_keep:
                    kept.append(row)
                    used += row["loss_tokens"]
                else:
                    stage_dropped.append(row)
            if not kept and group:
                kept = [group[0]]
                stage_dropped = group[1:]
                minimum_row = True
            if len(kept) != len(group):
                groups[source] = kept
                for row in stage_dropped:
                    item = _drop(row, "loss_token_share")
                    item["loss_tokens"] = row["loss_tokens"]
                    item["answer_tokens"] = row.get("answer_tokens")
                    dropped.append(item)
                changed = True
                total = sum(row["loss_tokens"] for group in groups.values() for row in group)
        if not changed:
            break
    else:
        raise SystemExit("loss_token_cap_did_not_converge")
    kept_rows = [row for source in sorted(groups) for row in groups[source]]
    total = sum(row["loss_tokens"] for row in kept_rows)
    unresolved = []
    for source, group in groups.items():
        src_tokens = sum(row["loss_tokens"] for row in group)
        if total and src_tokens * LOSS_SHARE_DENOMINATOR > total * LOSS_SHARE_NUMERATOR:
            unresolved.append(source)
    report = {
        "max_share": max_share,
        "policy": LOSS_BALANCE_POLICY,
        "dropped_rows": len(dropped),
        "dropped_loss_tokens": sum(item["loss_tokens"] for item in dropped),
        "minimum_one_row_forced": minimum_row,
        "unresolved_sources": unresolved,
        "after": loss_snapshot(kept_rows),
    }
    return kept_rows, dropped, report
