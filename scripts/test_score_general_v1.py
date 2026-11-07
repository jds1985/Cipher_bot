#!/usr/bin/env python3
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "scripts" / "fixtures" / "general-v1-fbbe.min.json"
SCORER = ROOT / "scripts" / "score_general_v1.py"


def main() -> int:
    out = subprocess.check_output([sys.executable, str(SCORER), str(FIXTURE)], text=True)
    doc = json.loads(FIXTURE.read_text())
    assert doc["trials"][0]["raw"] == "Paris."
    assert "trials 40 unique 20 identical_pairs 20 errors 0" in out
    assert "full=1" in out and "wrong=12" in out and "partial=4" in out
    assert "instruction_miss=3" in out and "hotel_template=8" in out
    assert "g01 full" in out and "g02 wrong hotel_template" in out
    assert "g04 wrong" in out and "g15 partial paragraph_echo" in out
    print("score fixture ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
