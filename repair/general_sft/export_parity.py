#!/usr/bin/env python3
"""Compare original and exported logits. Does not train.

The hotel export on random full-length windows had argmax agreement 0.947 and
mean abs logit diff about 0.061, with a max abs diff of 3.37. A repair export
should stay in that band. This does not measure answer quality.
"""

from __future__ import annotations

import argparse
import sys


def parity(original, exported) -> dict:
    if len(original) != len(exported) or any(len(a) != len(b) for a, b in zip(original, exported)):
        raise SystemExit("logit tensors differ in shape")
    n = 0
    agree = 0
    abs_sum = 0.0
    abs_max = 0.0
    for row_a, row_b in zip(original, exported):
        for a, b in zip(row_a, row_b):
            n += 1
            if max(range(len(a)), key=a.__getitem__) == max(range(len(b)), key=b.__getitem__):
                agree += 1
            for x, y in zip(a, b):
                d = abs(x - y)
                abs_sum += d
                if d > abs_max:
                    abs_max = d
    return {
        "argmax_agreement": agree / n,
        "mean_abs_logit_diff": abs_sum / sum(len(a) for row in original for a in row),
        "max_abs_logit_diff": abs_max,
    }


def acceptable(stats: dict) -> bool:
    return stats["argmax_agreement"] >= 0.90 and stats["mean_abs_logit_diff"] <= 0.25


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    if args.self_test:
        same = parity([[[0.1, 0.9, 0.0], [0.2, 0.1, 0.0]]], [[[0.1, 0.9, 0.0], [0.2, 0.1, 0.0]]])
        shifted = parity([[[0.0, 5.0]]], [[[5.0, 0.0]]])
        assert same["argmax_agreement"] == 1.0
        assert acceptable(same)
        assert shifted["argmax_agreement"] == 0.0
        assert not acceptable(shifted)
        print("export parity self-test ok")
        return 0
    print("Pass two logit tensors to parity() from the parent export run. No checkpoint is loaded here.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
