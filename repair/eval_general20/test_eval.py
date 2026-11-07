#!/usr/bin/env python3
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]


def main() -> int:
    out = Path("/tmp/general-v1-ids.tsv")
    subprocess.check_call([sys.executable, str(HERE / "build_ids.py"), str(out)])
    lines = [ln for ln in out.read_text().splitlines() if ln]
    assert len(lines) == 20
    g01 = lines[0].split("\t")
    assert g01[0] == "g01"
    ids = [int(x) for x in g01[1].split(",")]
    assert ids[0] == 4 and ids[-1] == 3
    assert len(ids) == 37
    subprocess.check_call([sys.executable, str(HERE / "compare_greedy.py"), "--self-test"])
    cc = subprocess.run(
        ["cc", "-O2", "-std=c11", "-o", "/tmp/greedy_chat",
         str(REPO / "native" / "cipher-serve" / "greedy_chat.c"),
         str(REPO / "native" / "cipher-serve" / "runtime" / "cipher.c"),
         "-lm", "-lpthread"],
        capture_output=True, text=True)
    assert cc.returncode == 0, cc.stderr
    missing = subprocess.run(["/tmp/greedy_chat"], capture_output=True, text=True)
    assert missing.returncode == 2
    assert "frozen" not in (HERE / "build_ids.py").read_text()
    assert "Canada" not in out.read_text()
    print("eval runner ok", "g01_tokens", len(ids))
    return 0


if __name__ == "__main__":
    sys.exit(main())
