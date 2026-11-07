#!/usr/bin/env python3
"""Write the repair jsonl from the rows in this file.

This file does not read the held-out prompt file. A separate gate compares
the written rows with that file after the fact.
Origin: original synthetic examples for this feasibility experiment.
No external corpus, no hotel rows, no web text.
"""

from __future__ import annotations

import json
from pathlib import Path

SYSTEM = "You are Cipher, a helpful assistant. Answer the user clearly and accurately. If you do not know, say so."
ORIGIN = "synthetic-original"
LICENSE = "Original synthetic examples written for this repair. No external corpus and no third-party text."

TRAIN = [
    ("knowledge", "What is the capital of Portugal?", "Lisbon."),
    ("knowledge", "What is the capital of Kenya?", "Nairobi."),
    ("knowledge", "What is the closest star to Earth?", "The Sun."),
    ("knowledge", "How many minutes are in one hour?", "There are 60 minutes in one hour."),
    ("knowledge", "How many days are in one week?", "There are 7 days in one week."),
    ("knowledge", "How many sides does a square have?", "A square has 4 sides."),
    ("knowledge", "What is the chemical symbol for water?", "H2O."),
    ("knowledge", "How many continents are there on Earth?", "There are 7 continents."),
    ("math", "What is 6 plus 7?", "13."),
    ("math", "What is 6 times 6?", "36."),
    ("math", "What is 18 minus 4?", "14."),
    ("math", "What is 30 divided by 5?", "6."),
    ("math", "A book costs 3 dollars. You pay with a 10 dollar bill. How much change should you receive?", "7 dollars."),
    ("math", "An apple costs 2 dollars. You pay with a 5 dollar bill. How much change should you receive?", "3 dollars."),
    ("math", "There are 6 green cups and 1 yellow cup. How many cups are there in total?", "There are 7 cups."),
    ("math", "A plate has 8 cookies. You eat 3. How many cookies are left?", "5 cookies are left."),
    ("math", "What is 2 plus 9?", "11."),
    ("math", "What is 7 times 3?", "21."),
    ("reasoning", "All oaks are trees. All trees have roots. Do all oaks have roots? Answer yes or no, then one sentence of reasoning.", "Yes. Oaks are trees, and trees have roots, so oaks have roots."),
    ("reasoning", "If every marble in a jar is blue, and this object is a marble from that jar, what color is it? Answer in one sentence.", "It is blue."),
    ("instruction", "Reply with exactly these three words and nothing else: silver gold copper.", "silver gold copper"),
    ("instruction", "Reply with exactly the digit 4 and nothing else.", "4"),
    ("instruction", "List three even numbers less than 8, separated by commas, and nothing else.", "2, 4, 6"),
    ("instruction", "Translate the English word cat into Spanish. Reply with only the translation.", "gato"),
    ("instruction", "Translate the English word house into German. Reply with only the translation.", "Haus"),
    ("comprehension", "Read this paragraph and answer the question using only the paragraph. Paragraph: North Clinic is on Pine Road. It opens at 9:00 AM on Monday and is closed on Thursday. The nurse is named Omar. Question: What time does North Clinic open on Monday, and is it open on Thursday?", "It opens at 9:00 AM on Monday and is closed on Thursday."),
    ("comprehension", "Read this paragraph and answer the question. Paragraph: A red wagon belongs to Beth. It has 12 stickers and stays in the shed. Question: Who owns the red wagon?", "Beth."),
    ("uncertainty", "What is the exact number of raindrops falling on London at this minute? If you cannot know, say so and do not invent a figure.", "I cannot know that, and I will not invent a figure."),
    ("uncertainty", "Who won the 2031 World Chess Championship? If that event has not happened or you cannot know, say so.", "I do not know, and I will not invent a name."),
    ("explanation", "Explain what an adjective is in two sentences.", "An adjective is a word that describes a noun. The word blue can describe a cup."),
    ("explanation", "In two sentences, what does a lever do?", "A lever helps move a load. You push one side, and the other side moves the load."),
    ("explanation", "In one sentence, what does a clock measure?", "A clock measures time."),
    ("explanation", "In one sentence, what does a map show?", "A map shows where places are."),
    ("creative", "Write a two-sentence story about a blue cup on a wooden table.", "A blue cup sat on a wooden table. A sunbeam made the cup look bright."),
    ("creative", "Tell a short clean joke about a hat.", "Why did the hat sit down? It needed to rest its brim."),
    ("knowledge", "Which continent is Brazil in?", "South America."),
]

VAL = [
    ("knowledge", "What is the capital of Peru?", "Lima."),
    ("math", "What is 11 plus 6?", "17."),
    ("math", "What is 9 minus 4?", "The difference is 5."),
    ("math", "A toy costs 5 dollars. You pay with a 20 dollar bill. How much change should you receive?", "15 dollars."),
    ("reasoning", "All whales are mammals. All mammals breathe air. Do all whales breathe air? Answer yes or no, then one sentence of reasoning.", "Yes. Whales are mammals, and mammals breathe air, so whales breathe air."),
    ("instruction", "Reply with exactly these three words and nothing else: one two three.", "one two three"),
    ("instruction", "List three even numbers greater than 6 and less than 14, separated by commas, and nothing else.", "8, 10, 12"),
    ("instruction", "Translate the English word water into German. Reply with only the translation.", "Wasser"),
    ("comprehension", "Read this paragraph and answer the question using only the paragraph. Paragraph: The green bench in Cedar Park was painted by Noor. It faces the flower gate. Question: Who painted the green bench?", "Noor."),
    ("uncertainty", "What is the exact number of clouds above your street at this minute? If you cannot know, say so and do not invent a figure.", "I do not know the number, and I will not invent one."),
    ("explanation", "In two sentences, what does a wheel do?", "A wheel lets a load roll. It turns around its center."),
    ("knowledge", "How many months are in one calendar year?", "12."),
]


def rows(split: str, items: list[tuple[str, str, str]]) -> list[dict]:
    out = []
    for i, (family, user, assistant) in enumerate(items, 1):
        out.append({
            "id": f"{split}-{i:02d}",
            "split": split,
            "family": family,
            "system": SYSTEM,
            "user": user,
            "assistant": assistant,
            "origin": ORIGIN,
            "license": LICENSE,
            "expert_checked_simple_fact": True,
        })
    return out


def main() -> None:
    root = Path(__file__).resolve().parent / "data"
    root.mkdir(parents=True, exist_ok=True)
    for name, items in (("train", TRAIN), ("val", VAL)):
        text = "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows(name, items))
        (root / f"{name}.jsonl").write_text(text, encoding="utf-8")
        print(f"wrote {name} {len(items)}")


if __name__ == "__main__":
    main()
