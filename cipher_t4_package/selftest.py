#!/usr/bin/env python3
"""Adversarial checks for the pack. Uses only files inside this directory."""

from __future__ import annotations

import json
import os
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
    ]}, ensure_ascii=False) + "\n"


def read_jsonl(path: Path) -> list[dict]:
    rows = []
    for line in path.read_bytes().decode("utf-8").split("\n"):
        if line.endswith("\r"):
            line = line[:-1]
        if line.strip():
            rows.append(json.loads(line))
    return rows


def write_adv() -> None:
    ADV.mkdir(parents=True, exist_ok=True)
    files = {
        "dolly_15k_human_cc_by_sa_3_0.jsonl": [
            row("What is the capital of France?", "Paris."),
            row("Please tell me the capital of France.", "Paris."),
            row("As an AI language model I refuse.", "I cannot."),
            row("Same dolly question about brass hinges.", "Brass hinges turn."),
            row("Same dolly question about brass hinges.", "Duplicate must drop."),
            row("Good morning in Spanish, plus zebra quartz.", "Hola."),
            row("Where was the first automobile workshop?", "Karl Benz"),
            row("Name the person who built the first car.", "Karl Benz"),
            row("Which country has New Delhi as its capital?", "India"),
            row("Name the country whose capital is New Delhi.", "India"),
            row("Which country is Tokyo in?", "Japan"),
            row("Tokyo is the capital of which country?", "Japan"),
            row("Is water wet? Reply with one word.", "yes"),
            row("Does ice float? Reply with one word.", "yes"),
            row("Describe the museum opening in one sentence.", "The museum opened beside the river in eighteen twenty."),
            row("When did that riverside museum first open to visitors?", "The museum opened beside the river in eighteen twenty."),
        ] + [row(f"Dolly unique question number {i} about gardens.", f"Garden note {i}.") for i in range(24)],
        "oasst2_en_human_apache_2_0.jsonl": [row(f"OASST question {i} about rivers.", f"River note {i}.") for i in range(12)] + [
            row("OASST separator question about rivers and stones.", "A stone\u2028still one answer"),
        ],
        "aya_dataset_en_original_annotations_human_apache_2_0.jsonl": [row(f"Aya question {i} about cloth.", f"Cloth note {i}.") for i in range(12)],
        "squad_v2_passage_qa_human_cc_by_sa_4_0_capped.jsonl": (
            [row(f"SQuAD passage question {i} about bridges.", f"Bridge note {i}.") for i in range(12)]
            + [row(f"SQuAD unanswerable case {i} about missing dates.", "The text doesn't say.") for i in range(12)]
            + [row(f"SQuAD unanswerable case {i} about missing names.", "The passage doesn't contain the answer to that.") for i in range(12)]
            + [row(f"SQuAD unanswerable case {i} about missing places.", "I can't tell from the text.") for i in range(12)]
        ),
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
    train = read_jsonl(out / "train.jsonl")
    val = read_jsonl(out / "val.jsonl")
    def n(s):
        return " ".join(s.lower().split())
    assert not ({n(r["user"]) for r in train} & {n(r["user"]) for r in val})
    blob = "\n".join(r["user"] for r in train + val).lower()
    assert "capital of france" not in blob
    assert "as an ai language model" not in "\n".join(r["assistant"] for r in train + val).lower()
    files = Counter(r["source_file"] for r in train + val)
    assert not any("cnn" in k or "synthetic" in k or "unknown" in k for k in files)
    assert set(r["source_file"] for r in train) == set(r["source_file"] for r in val)
    licenses = {r["license"] for r in train + val}
    assert "CC-BY-SA-3.0" in licenses and "CC-BY-SA-4.0" in licenses and "MIT" in licenses
    assert all(r["revision"] == "UNKNOWN" for r in train)
    assert all(r["sharealike"] for r in train if r["license"].startswith("CC-BY-SA"))
    quality = json.loads((out / "quality.json").read_text())
    assert quality["gate"] == "ok"
    assert quality["reconcile"]["identity_ok"] is True
    assert quality["reconcile"]["pinned_counted_as_exclusions"] is False
    assert quality["row_share_cap"] == "not applied"
    assert "not a general-uncertainty curriculum" in quality["uncertainty_supervision"]["statement"]
    for slot in quality["loss_tokens_train"]["by_source"].values():
        assert slot["share"] <= 0.40
    held = (HERE / "fixtures" / "general-v2.sha256").read_text().split()[0]
    assert held == "3c15169dfd848b57209b71813f75f972c74c35a0ce745c803376db33cb1323f9"
    assert "baseline_v2" not in (HERE / "build_balanced.py").read_text()
    cc = subprocess.run(
        ["cc", "-O2", "-std=c11", "-o", "/tmp/greedy_chat_pkg",
         str(HERE / "eval" / "greedy_chat.c"), str(HERE / "runtime" / "cipher.c"), "-lm", "-lpthread"],
        capture_output=True, text=True)
    assert cc.returncode == 0, cc.stderr
    held_sha = (HERE / "fixtures" / "general-v2.sha256").read_text().split()[0]
    embedded = "keep\u2028me\u2029together"
    sample = ADV / "line_separators.jsonl"
    raw = (
        '{"messages":[{"role":"user","content":"' + embedded + '"},{"role":"assistant","content":"still one row"}]}'
        + "\n"
        + '{"messages":[{"role":"user","content":"controls \\u000b\\u000c\\u001c\\u001d\\u001e\\u0085"},{"role":"assistant","content":"ok"}]}'
        + "\n"
    )
    sample.write_bytes(raw.encode("utf-8"))
    from build_balanced import jsonl_records
    recs = list(jsonl_records(sample))
    assert len(recs) == 2, len(recs)
    assert json.loads(recs[0])["messages"][0]["content"] == embedded
    controls = json.loads(recs[1])["messages"][0]["content"]
    assert controls == "controls \x0b\x0c\x1c\x1d\x1e\x85"
    assert len(raw.splitlines()) > len(recs)
    env = dict(**os.environ)
    env["BASELINE_ARGV_ONLY"] = "1"
    argv = subprocess.run(
        [sys.executable, str(HERE / "eval" / "baseline_v2.py"),
         "--pt", "sft_model.pt", "--tokenizer", "tokenizer.json", "--out", "baseline-v2.jsonl", "--ctx", "512"],
        cwd=HERE, env=env, text=True, capture_output=True)
    assert argv.returncode == 0, argv.stdout + argv.stderr
    assert "--tokenizer" in argv.stdout and "tokenizer.json" in argv.stdout
    assert "--ctx" in argv.stdout and "512" in argv.stdout
    assert held_sha == "3c15169dfd848b57209b71813f75f972c74c35a0ce745c803376db33cb1323f9"
    assert quality["fixture_selftest_is_not_real_data"] is True
    joined = train + val
    templates = [
        "the text doesn't say.",
        "the passage doesn't contain the answer to that.",
        "i can't tell from the text.",
    ]
    for template in templates:
        copies = [r for r in joined if " ".join(r["assistant"].lower().split()) == template]
        assert copies and len(copies) <= 4, (template, len(copies))
        assert all(any(c is row for row in train) for c in copies)
    exclusions = read_jsonl(out / "exclusions.jsonl")
    reasons = Counter(r["reason"] for r in exclusions)
    assert "pinned_unanswerable_to_train" not in reasons
    assert reasons["unanswerable_template_cap"] > 0
    assert reasons["substantial_answer_repeat"] >= 1
    lexical = [r for r in exclusions if r["kind"] == "lexical_clone"]
    g14 = [r for r in lexical if r["matched_frozen_id"] == "g14"]
    assert g14 and g14[0]["reason"] == "jaccard" and g14[0]["similarity"] >= 0.5
    assert "user" not in g14[0] and "assistant" not in g14[0]
    frozen_doc = json.loads((HERE / "fixtures" / "general-v1.json").read_text())
    frozen_g14 = next(p["text"] for p in frozen_doc["prompts"] if p["id"] == "g14")
    exclusion_text = (out / "exclusions.jsonl").read_text(encoding="utf-8")
    assert frozen_g14 not in exclusion_text
    assert not any("zebra quartz" in r["user"] for r in joined)
    long_answer = "the museum opened beside the river in eighteen twenty."
    assert sum(1 for r in joined if " ".join(r["assistant"].lower().split()) == long_answer) <= 1
    audit = quality["assistant_audit"]
    assert audit["unique_shared"] == len(audit["shared"])
    assert "short_answer_exceptions" in audit
    raw_sep = "\n".join(r["assistant"] for r in joined)
    assert "\u2028" in raw_sep
    assert len(raw_sep.splitlines()) > raw_sep.count("\n") + 1
    scale_and_gate()
    pack_cases()
    loss_cap_keeps_hash_order()
    proportional_fixture()
    print("package selftest ok", "train", len(train), "val", len(val))
    return 0


def scale_and_gate() -> None:
    sys.path.insert(0, str(HERE / "lib"))
    from mix_rules import STOP, apply_answer_policy, assistant_audit, clone_match, content_tokens, jaccard, load_frozen
    filler = []
    line = 1
    for i in range(3534):
        filler.append({
            "user": f"SQuAD answerable passage number {i} asks about a distinct span.",
            "assistant": f"Span value number {i} from the passage.",
            "source_file": "squad_v2_passage_qa_human_cc_by_sa_4_0_capped.jsonl",
            "source_line": line,
        })
        line += 1
    counts = {"The text doesn't say.": 129, "The passage doesn't contain the answer to that.": 127, "I can't tell from the text.": 103}
    templates = []
    for answer, count in counts.items():
        for i in range(count):
            templates.append({
                "user": f"Unanswerable passage {answer} number {i} with its own question.",
                "assistant": answer,
                "source_file": "squad_v2_passage_qa_human_cc_by_sa_4_0_capped.jsonl",
                "source_line": line,
            })
            line += 1
    assert len(filler) + len(templates) == 3893
    kept, excluded, impact = apply_answer_policy(filler + templates)
    kept_counts = Counter(" ".join(r["assistant"].lower().split()) for r in kept if r["assistant"] in counts)
    assert kept_counts["the text doesn't say."] == 4
    assert kept_counts["the passage doesn't contain the answer to that."] == 4
    assert kept_counts["i can't tell from the text."] == 4
    assert sum(1 for r in excluded if r["reason"] == "unanswerable_template_cap") == 347
    assert impact["by_source"]["squad_v2_passage_qa_human_cc_by_sa_4_0_capped.jsonl"]["budget"] == 77
    assert impact["by_source"]["squad_v2_passage_qa_human_cc_by_sa_4_0_capped.jsonl"]["ratio_floor_one_per_observed_template"] is False
    small = []
    for i in range(40):
        small.append({"user": f"small passage {i}", "assistant": f"small distinct span {i} here", "source_file": "squad_small.jsonl", "source_line": i + 1})
    n = 41
    for answer in counts:
        for i in range(10):
            small.append({"user": f"small unanswerable {answer} {i}", "assistant": answer, "source_file": "squad_small.jsonl", "source_line": n})
            n += 1
    kept_small, excluded_small, _ = apply_answer_policy(small)
    small_counts = Counter(r["assistant"] for r in kept_small if r["assistant"] in counts)
    assert all(small_counts[a] == 1 for a in counts), small_counts
    assert any(r["reason"] == "unanswerable_ratio" for r in excluded_small)
    shared = [
        {"user": "question alpha about the workshop", "assistant": "Karl Benz", "source_file": "a.jsonl", "source_line": 1},
        {"user": "question beta about the workshop", "assistant": "Karl Benz", "source_file": "a.jsonl", "source_line": 2},
        {"user": "long one", "assistant": "The museum opened beside the river in eighteen twenty.", "source_file": "a.jsonl", "source_line": 3},
        {"user": "long two", "assistant": "The museum opened beside the river in eighteen twenty.", "source_file": "a.jsonl", "source_line": 4},
    ] + [
        {"user": f"yes question {i}", "assistant": "yes", "source_file": "a.jsonl", "source_line": 10 + i} for i in range(9)
    ]
    kept_shared, excluded_shared, _ = apply_answer_policy(shared)
    assert sum(1 for r in kept_shared if r["assistant"] == "Karl Benz") == 2
    assert sum(1 for r in kept_shared if r["assistant"].startswith("The museum")) == 1
    assert sum(1 for r in kept_shared if r["assistant"] == "yes") == 8
    assert any(r["reason"] == "short_answer_cap" and r["assistant_norm"] == "yes" for r in excluded_shared)
    import tempfile
    gate = HERE / "lib" / "sft_data_gate.py"
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        tr, va = root / "tr.jsonl", root / "va.jsonl"
        def dump(path, rows):
            path.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
        dump(tr, [
            {"user": "Where is the Taj Mahal?", "assistant": "India", "source_file": "dolly.jsonl", "source_line": 1},
            {"user": "Capital question one.", "assistant": "yes", "source_file": "dolly.jsonl", "source_line": 2},
            {"user": "Unanswerable kept.", "assistant": "The text doesn't say.", "source_file": "squad.jsonl", "source_line": 3},
        ])
        dump(va, [
            {"user": "Which country is the Taj Mahal in?", "assistant": "India", "source_file": "dolly.jsonl", "source_line": 4},
            {"user": "Capital question two.", "assistant": "yes", "source_file": "dolly.jsonl", "source_line": 5},
        ])
        ok = subprocess.run([sys.executable, str(gate), "--train", str(tr), "--val", str(va), "--max-assistant-repeat", "1"], text=True, capture_output=True)
        assert ok.returncode == 0, ok.stdout + ok.stderr
        assert "unique_shared" in ok.stdout or "train_val_assistant_overlap 2" in ok.stdout
        audit_ok, problems = assistant_audit(read_jsonl(tr), read_jsonl(va))
        assert audit_ok["unique_shared"] == 2
        assert audit_ok["shared_rows_train"] == 2 and audit_ok["shared_rows_val"] == 2
        assert problems == []
        assert {item["assistant_norm"] for item in audit_ok["short_answer_exceptions"]} == {"india", "yes"}
        dump(va, read_jsonl(va) + [{"user": "Another passage question.", "assistant": "The text doesn't say.", "source_file": "squad.jsonl", "source_line": 9}])
        bad = subprocess.run([sys.executable, str(gate), "--train", str(tr), "--val", str(va), "--max-assistant-repeat", "1"], text=True, capture_output=True)
        assert bad.returncode == 2 and "unanswerable template" in bad.stdout
        dump(tr, [{"user": f"repeat long {i}", "assistant": "This answer is a long shared sentence about bridges.", "source_file": "s.jsonl", "source_line": i} for i in range(2)])
        dump(va, [{"user": "different val question about cloth", "assistant": "Cloth note.", "source_file": "s.jsonl", "source_line": 8}])
        bad2 = subprocess.run([sys.executable, str(gate), "--train", str(tr), "--val", str(va), "--max-assistant-repeat", "1"], text=True, capture_output=True)
        assert bad2.returncode == 2 and "substantial" in bad2.stdout
    frozen = load_frozen([HERE / "fixtures" / "general-v1.json", HERE / "fixtures" / "general-v2.json"])
    user = "Good morning in Spanish, plus zebra quartz."
    hit = clone_match(user, frozen)
    assert hit["matched_frozen_id"] == "g14" and hit["reason"] == "jaccard" and hit["similarity"] == 0.5
    old_stop = set(STOP) - {
        "words", "word", "list", "separated", "commas", "translate", "english", "phrase",
        "translation", "should", "receive", "pay", "cost", "costs", "dollar", "dollars",
        "bill", "together", "more", "less",
    }

    def old_tokens(text: str) -> set[str]:
        import re
        return {w for w in re.findall(r"[a-z0-9]+", text.lower()) if w not in old_stop}

    entry = next(item for item in frozen if item["id"] == "g14")
    assert jaccard(old_tokens(user), old_tokens(frozen_text("g14"))) < 0.5
    assert jaccard(content_tokens(user), entry["tokens"]) >= 0.5


def frozen_text(ident: str) -> str:
    doc = json.loads((HERE / "fixtures" / "general-v1.json").read_text())
    return next(p["text"] for p in doc["prompts"] if p["id"] == ident)


def loss_cap_keeps_hash_order() -> None:
    sys.path.insert(0, str(HERE / "lib"))
    from mix_rules import cap_loss_tokens, loss_rank
    from plan import planned_steps
    rows = []
    for line, tokens in enumerate([50, 10, 10, 10, 50, 10, 10, 10], start=1):
        rows.append({"source_file": "big.jsonl", "source_line": line, "loss_tokens": tokens, "assistant": "x"})
    for name in ("a.jsonl", "b.jsonl", "c.jsonl"):
        for line in range(1, 4):
            rows.append({"source_file": name, "source_line": line, "loss_tokens": 10, "assistant": "y"})
    kept, dropped, report = cap_loss_tokens(rows, seed=20261107)
    assert report["unresolved_sources"] == []
    for slot in report["after"]["by_source"].values():
        assert slot["share"] <= 0.40
    big_kept = [row for row in kept if row["source_file"] == "big.jsonl"]
    ordered = sorted((row for row in rows if row["source_file"] == "big.jsonl"), key=lambda row: loss_rank(20261107, row))
    budget = 90 * 40 // 60
    simulated, used = [], 0
    for row in ordered:
        if used + row["loss_tokens"] <= budget:
            simulated.append(row["source_line"])
            used += row["loss_tokens"]
    assert sorted(row["source_line"] for row in big_kept) == sorted(simulated)
    found = False
    for seed in range(30):
        kept_seed, dropped_seed, report_seed = cap_loss_tokens(rows, seed=seed)
        assert report_seed["unresolved_sources"] == []
        if any(row["loss_tokens"] == 50 for row in kept_seed) and any(row["loss_tokens"] == 10 for row in dropped_seed):
            found = True
    assert found
    assert planned_steps(17057) == 533
    assert planned_steps(31) == 1


def proportional_fixture() -> None:
    root = HERE / "fixtures" / "proportional_labeled"
    root.mkdir(parents=True, exist_ok=True)
    (root / "LABEL.txt").write_text(
        "LABEL: proportional stand-in. Not the parent corpus and not the v4 row counts.\n"
        "Synthetic files use the catalog names so the builder accepts them. OASST answers are long and\n"
        "SQuAD answers are short, which is enough to test a loss-token cap without the real jsonl.\n",
        encoding="utf-8",
    )
    def messages(user: str, assistant: str) -> str:
        return json.dumps({"messages": [
            {"role": "user", "content": user},
            {"role": "assistant", "content": assistant},
        ]}, ensure_ascii=False) + "\n"
    oasst = [messages(
        f"OASST labeled fixture question {i} about rivers and towns.",
        (("detail " * (80 if i < 2 else 40)).strip() + f" case {i}"),
    ) for i in range(24)]
    oasst.append(messages("OASST labeled fixture overflow answer about maps.", ("detail " * 1100).strip()))
    oasst.append(messages(("question " * 1100).strip(), "Short."))
    squad = [messages(f"SQuAD labeled fixture passage {i} about copper roofs.", f"Span {i}.") for i in range(36)]
    for template in (
        "The text doesn't say.",
        "The passage doesn't contain the answer to that.",
        "I can't tell from the text.",
    ):
        for i in range(8):
            squad.append(messages(f"SQuAD labeled fixture unanswerable {template} {i} unique.", template))
    files = {
        "oasst2_proportional.jsonl": oasst,
        "squad_v2_proportional.jsonl": squad,
        "dolly_15k_proportional.jsonl": [messages(f"Dolly labeled fixture question {i} about gardens.", f"Garden note number {i} stays distinct.") for i in range(18)]
            + [messages("What is the capital of France?", "Paris.")]
            + [messages("Too short", "No.")]
            + [messages("Dolly labeled fixture duplicate user about brass.", "First.")]
            + [messages("Dolly labeled fixture duplicate user about brass.", "Second.")],
        "aya_dataset_proportional.jsonl": [messages(f"Aya labeled fixture question {i} about cloth.", f"Cloth note number {i} stays distinct.") for i in range(14)],
        "gsm8k_proportional.jsonl": [messages(f"GSM labeled fixture problem {i} with bags.", f"Step one two three four five six for problem {i}.") for i in range(16)],
        "mbpp_proportional.jsonl": [messages(f"MBPP labeled fixture task {i} write code.", f"return value {i} from the function") for i in range(10)],
    }
    for name, lines in files.items():
        (root / name).write_text("".join(lines), encoding="utf-8")
    out = HERE / "out-proportional"
    proc = subprocess.run(
        [sys.executable, str(HERE / "build_balanced.py"), "--sources", str(root), "--out", str(out), "--word-tokens"],
        text=True, capture_output=True)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    quality = json.loads((out / "quality.json").read_text())
    assert quality["fixture_selftest_is_not_real_data"] is True
    assert quality["reconcile"]["identity_ok"] is True
    assert quality["reconcile"]["pinned_counted_as_exclusions"] is False
    before = quality["loss_tokens_before_cap"]["by_source"]
    after = quality["loss_tokens_after_cap"]["by_source"]
    oasst_name = next(name for name in before if "oasst" in name)
    assert before[oasst_name]["share"] > 0.40
    for slot in after.values():
        assert slot["share"] <= 0.40
    squad_name = next(name for name in after if "squad" in name)
    assert after[squad_name]["rows"] >= 30
    assert "not a general-uncertainty curriculum" in quality["uncertainty_supervision"]["statement"]
    assert quality["uncertainty_supervision"]["templates_rewritten"] is False
    exclusions = read_jsonl(out / "exclusions.jsonl")
    overflows = [item for item in exclusions if item["reason"] in {"answer_exceeds_context", "prompt_exceeds_context"}]
    assert {item["reason"] for item in overflows} == {"answer_exceeds_context", "prompt_exceeds_context"}
    assert all(item["source_file"] and item["source_line"] and item["answer_tokens"] and item["prompt_tokens"] for item in overflows)
    packed = subprocess.run(
        [sys.executable, str(HERE / "pack_rows.py"), "--data", str(out), "--word-tokens"],
        text=True, capture_output=True)
    assert packed.returncode == 0, packed.stdout + packed.stderr
    report = json.loads((out / "pack_report.json").read_text())
    assert report["truncated_answer_rows"] == 0
    assert report["train"]["truncated_answer_rows"] == 0
    assert report["context_drops"]
    assert all(item.get("source_file") and item.get("source_line") is not None for item in report["context_drops"])
    sys.path.insert(0, str(HERE / "lib"))
    from plan import planned_steps
    assert report["planned_steps"] == planned_steps(report["train"]["packed"])
    launch = subprocess.run(
        [sys.executable, str(HERE / "train_t4.py"), "--data", str(out), "--base", "missing.pt", "--out", str(out / "run")],
        text=True, capture_output=True)
    assert launch.returncode == 2 and "tokenizer_mode_refused" in launch.stdout + launch.stderr


def pack_cases() -> None:
    from pack_rows import EOT, PAD, ASSISTANT, pack_row
    def encode(text: str) -> list[int]:
        return [10 + (ord(ch) % 40) for ch in text]
    short = pack_row(encode, {"system": "S", "user": "Hello there", "assistant": "Hi"}, ctx=64)
    assert short["status"] == "ok" and short["truncated_tokens"] == 0
    assert len(short["ids"]) == 64 and short["ids"][0] == 4
    assert sum(short["mask"]) == short["supervised_tokens"]
    assert short["ids"][short["prompt_tokens"] + short["supervised_tokens"] - 1] == EOT
    assert all(token == PAD for token in short["ids"][short["prompt_tokens"] + short["supervised_tokens"]:])
    assert all(bit == 0 for bit in short["mask"][:short["prompt_tokens"]])
    too_long = pack_row(encode, {"system": "S", "user": "U" * 40, "assistant": "A" * 10}, ctx=16)
    assert too_long["status"] == "reject" and too_long["reason"] == "prompt_exceeds_context"
    assert too_long["ids"] == [] and too_long["mask"] == []
    overflow = pack_row(
        encode,
        {"system": "S", "user": "Hi", "assistant": "A" * 100, "source_file": "oasst2_en.jsonl", "source_line": 49},
        ctx=32,
    )
    assert overflow["status"] == "reject" and overflow["reason"] == "answer_exceeds_context"
    assert overflow["ids"] == [] and overflow["supervised_tokens"] == 0
    assert overflow["source_file"] == "oasst2_en.jsonl" and overflow["source_line"] == 49
    assert overflow["answer_tokens"] == 100
    prompt_over = pack_row(
        encode,
        {"system": "S", "user": "U" * 40, "assistant": "A", "source_file": "dolly_15k.jsonl", "source_line": 7},
        ctx=16,
    )
    assert prompt_over["status"] == "reject" and prompt_over["reason"] == "prompt_exceeds_context"
    assert prompt_over["source_file"] == "dolly_15k.jsonl" and prompt_over["source_line"] == 7


if __name__ == "__main__":
    raise SystemExit(main())
