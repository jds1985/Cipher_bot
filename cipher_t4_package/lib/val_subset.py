"""One frozen validation subset for checkpoint selection.

The same row indices and the same token-weighted loss are the only numbers
that may be compared across checkpoints, including the step-0 base. A full
validation loss is a separate report and is not an argument to this comparison.
"""

from __future__ import annotations

import hashlib


def round_robin_indices(n_rows: int, sources: list[str] | None, want: int) -> list[int]:
    if n_rows <= 0 or want <= 0:
        return []
    if not sources or len(sources) != n_rows:
        if n_rows <= want:
            return list(range(n_rows))
        return [min(n_rows - 1, int(i * n_rows / want)) for i in range(want)]
    buckets: dict[str, list[int]] = {}
    for index, name in enumerate(sources):
        buckets.setdefault(str(name), []).append(index)
    picked: list[int] = []
    keys = sorted(buckets)
    while len(picked) < want and any(buckets[key] for key in keys):
        for key in keys:
            if buckets[key]:
                picked.append(buckets[key].pop(0))
            if len(picked) >= want:
                break
    return picked


def subset_record(indices: list[int]) -> dict:
    raw = ",".join(str(index) for index in indices).encode()
    return {
        "count": len(indices),
        "indices": list(indices),
        "sha256": hashlib.sha256(raw).hexdigest(),
    }


def consider_best(best: dict | None, step: int, subset_loss: float | None) -> tuple[dict | None, bool]:
    """Compare subset losses only. An equal loss keeps the earlier step."""
    if subset_loss is None:
        return best, False
    if best is None or float(subset_loss) < float(best["subset_loss"]):
        return {"step": step, "subset_loss": float(subset_loss)}, True
    return best, False
