"""Step count shared by the pack report and the trainer launcher.

One optimizer step is batch 4 times grad accumulation 8, so 32 packed train
rows. The trainer drops a trailing partial step. The cap is 800 steps.
"""

ROWS_PER_STEP = 32
MAX_STEPS = 800


def planned_steps(packed_train_rows: int) -> int:
    if packed_train_rows < 1:
        raise ValueError("no packed train rows")
    full = packed_train_rows // ROWS_PER_STEP
    return max(1, min(MAX_STEPS, full or 1))
