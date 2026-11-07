#!/usr/bin/env python3
"""Score a general-v1 raw export. Does not call a model and does not replace raw text.

Labels follow the frozen rubric in general-v1.json. Gold checks are the
conditions for those labels. They are not answers to ship in the app.
"""

from __future__ import annotations

import json
import re
import sys

HOTEL = re.compile(
    r"front desk|call 911|on file for this hotel|rather not guess|late checkout",
    re.I,
)


def sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[.!?])\s+", text.strip())
    return [p for p in parts if p]


def hotel(text: str) -> bool:
    return HOTEL.search(text) is not None


def score_one(item_id: str, raw: str) -> dict:
    text = raw or ""
    low = text.lower().strip()
    pattern = "hotel_template" if hotel(text) else "other"
    label = "wrong"
    why = ""

    if item_id == "g01":
        if re.search(r"\bparis\b", low) and not hotel(text):
            label, why = "full", "Names Paris and does not use the hotel script."
        else:
            why = "Does not name Paris."
    elif item_id == "g02":
        if re.search(r"\b366\b|three hundred (?:and )?sixty-six", low) and not hotel(text):
            label, why = "full", "Gives 366."
        else:
            why = "Does not give 366."
    elif item_id == "g03":
        if re.search(r"\bsaturn\b", low):
            label, why = "full", "Names Saturn."
        else:
            why = "Does not name Saturn."
    elif item_id == "g04":
        if re.search(r"\b102\b", text) and not re.search(r"\b112\b", text):
            label, why = "full", "States 102."
        else:
            why = "17 times 6 is 102."
    elif item_id == "g05":
        if re.search(r"\b25\b", text):
            label, why = "full", "States 25."
        else:
            why = "100 divided by 4 is 25."
    elif item_id == "g06":
        if re.search(r"(\$ ?12\b|\b12\b)", text) and not hotel(text):
            label, why = "full", "States 12 dollars of change."
        else:
            why = "Change is 12 dollars."
    elif item_id == "g07":
        if re.match(r"yes\b", low) and re.search(r"lazzles", low):
            label, why = "full", "Answers yes and keeps the chain."
        else:
            label, why = "instruction_miss", "Does not answer yes or no, then one sentence."
    elif item_id == "g08":
        if re.search(r"(\$ ?0?\.05\b|\b5 cents\b|\b0\.05\b)", low):
            label, why = "full", "Ball is 5 cents."
        else:
            why = "Ball is 5 cents, not 10 cents."
    elif item_id == "g09":
        ok = re.search(r"366|february 29|feb\.? 29|extra day|leap day", low)
        if ok and len(sentences(text)) >= 2:
            label, why = "full", "Two sentences and the extra day."
        elif ok:
            label, why = "partial", "Has the fact but not two sentences."
        else:
            why = "Does not explain the extra day."
    elif item_id == "g10":
        if re.search(r"less dense|lower density|\bdensity\b|hydrogen bond", low):
            label, why = "full", "Gives density."
        else:
            why = "Does not give density."
    elif item_id == "g11":
        if re.search(r"\btemperature\b", low) and "temperature-like" not in low and len(sentences(text)) == 1:
            label, why = "full", "One sentence: temperature."
        elif "thermometer" in low or "temperature" in low:
            label, pattern = "partial", "other"
            why = "One sentence about the device, and it does not say temperature."
        else:
            why = "Does not say a thermometer measures temperature."
    elif item_id == "g12":
        if low == "red blue green":
            label, why = "full", "Exact three words."
        else:
            label, why = "instruction_miss", "Not exactly: red blue green."
    elif item_id == "g13":
        if re.fullmatch(r"\s*(?:[2357]|1[1379])(?:\s*,\s*(?:[2357]|1[1379])){3}\s*\.?\s*", low):
            label, why = "full", "Four primes under 20, commas only."
        else:
            label, why = "instruction_miss", "Not four primes under 20 separated only by commas."
    elif item_id == "g14":
        if low.strip(" .!") in {"buenos días", "buenos dias", "buen día", "buen dia"}:
            label, why = "full", "Spanish phrase only."
        else:
            why = "Not the Spanish for good morning."
    elif item_id == "g15":
        sat = re.search(r"8(?::00)?\s*(?:a\.?m\.?|am)", low)
        closed = re.search(r"(closed on sunday|not open on sunday|sunday.{0,24}closed|no[, ].{0,12}sunday)", low)
        if sat and closed:
            label, why = "full", "Saturday 8:00 AM and closed Sunday."
        elif "maple" in low or "oak street" in low:
            label, pattern = "partial", "paragraph_echo"
            why = "Uses the bakery and does not answer Saturday or Sunday."
        else:
            why = "Does not answer from the paragraph."
    elif item_id == "g16":
        if re.search(r"\b55\b", text) and not hotel(text):
            label, why = "full", "55 pages unused."
        else:
            why = "80 - 15 - 10 = 55."
    elif item_id == "g17":
        unk = re.search(r"do not know|don't know|cannot know|can't know|cannot be known|no way to know|not possible to know", low)
        invent = re.search(r"\b\d{3,}\b", text)
        if unk and not invent and not hotel(text):
            label, why = "uncertain", "Says it cannot know and gives no figure."
        else:
            why = "Does not say the count is unknowable."
    elif item_id == "g18":
        if re.search(r"has not happened|hasn't happened|not happened yet|in the future|has not (?:yet )?taken place|cannot know|do not know", low) and not hotel(text):
            label, why = "uncertain", "Says the 2035 event is not available."
        else:
            why = "Does not say the event has not happened."
    elif item_id == "g19":
        boat = "paper boat" in low or ("boat" in low and "paper" in low)
        pond = "pond" in low
        if boat and pond and len(sentences(text)) == 2 and not hotel(text):
            label, why = "full", "Two sentences, paper boat, pond."
        elif boat:
            label, pattern = "partial", pattern
            why = "Mentions a paper boat and misses the pond or adds the hotel closer."
        else:
            why = "Not a two-sentence pond story."
    elif item_id == "g20":
        if "pencil" in low and not hotel(text) and len(sentences(text)) <= 3:
            label, why = "full", "Short pencil joke without the hotel closer."
        elif "pencil" in low:
            label, pattern = "partial", pattern
            why = "Pencil joke shape, then the hotel closer."
        else:
            why = "Not a pencil joke."
    else:
        label, why = "error", "Unknown prompt id."
    if hotel(text) and pattern == "other":
        pattern = "hotel_template"
    return {"id": item_id, "label": label, "pattern": pattern, "why": why}


def score_export(doc: dict) -> dict:
    trials = doc["trials"]
    rows = []
    for t in trials:
        row = score_one(t["id"], t.get("raw") or "")
        row["pass"] = t.get("pass")
        row["family"] = t.get("family")
        row["raw"] = t.get("raw") or ""
        row["error"] = t.get("error")
        stats = t.get("stats") or {}
        row["genTokens"] = stats.get("genTokens")
        row["promptTokens"] = stats.get("promptTokens")
        row["halt"] = stats.get("halt")
        row["haltToken"] = stats.get("haltToken")
        rows.append(row)
    by = {}
    for row in rows:
        by.setdefault(row["id"], {})[row["pass"]] = row["raw"]
    identical = {i: len(set(v.values())) == 1 for i, v in by.items()}
    labels = {}
    # one label per id from pass 1; flag if pass 2 differs
    for row in rows:
        if row["pass"] == 1:
            labels[row["id"]] = row["label"]
    return {
        "n": len(rows),
        "unique": len(by),
        "identicalPairs": sum(1 for v in identical.values() if v),
        "errors": sum(1 for r in rows if r["error"]),
        "labels": labels,
        "rows": rows,
    }


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: score_general_v1.py RAW.json", file=sys.stderr)
        return 1
    doc = json.loads(open(argv[1], encoding="utf-8").read())
    out = score_export(doc)
    counts = {}
    patterns = {}
    for i, lab in out["labels"].items():
        counts[lab] = counts.get(lab, 0) + 1
    for row in out["rows"]:
        if row["pass"] != 1:
            continue
        patterns[row["pattern"]] = patterns.get(row["pattern"], 0) + 1
    print(f"trials {out['n']} unique {out['unique']} identical_pairs {out['identicalPairs']} errors {out['errors']}")
    print("labels " + " ".join(f"{k}={counts[k]}" for k in sorted(counts)))
    print("patterns " + " ".join(f"{k}={patterns[k]}" for k in sorted(patterns)))
    print("id label pattern gen why")
    for row in out["rows"]:
        if row["pass"] != 1:
            continue
        print(f"{row['id']} {row['label']} {row['pattern']} gen={row['genTokens']} {row['why']}")
        print(f"  raw: {row['raw']}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
