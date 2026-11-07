"""Step count shared by the pack report and the trainer launcher.

One optimizer step is batch 4 times grad accumulation 8, so 32 packed rows.
A full epoch is packed_rows // 32 steps. The leftover packed_rows % 32 rows
never fill a step. That partial batch is not the same thing as rows skipped
because a step cap stopped the run early.

The authorized ceiling is 900 steps, one epoch of the v5 mix (893 steps).
The old ceiling of 800 stopped at 25,600 rows and left 2,982 rows unseen.
The 3 hour wall clock remains the resource stop. 900 is not a promise that
the clock will allow every step.
"""

ROWS_PER_STEP = 32
MAX_STEPS = 900
PRIOR_PADDED_TOKENS_PER_S = 3212
PACK_CTX = 1024


def schedule(packed_train_rows: int, rows_per_step: int = ROWS_PER_STEP, max_steps_cap: int = MAX_STEPS) -> dict:
    if packed_train_rows < 1:
        raise ValueError("no packed train rows")
    if rows_per_step < 1:
        raise ValueError("rows_per_step")
    epoch_steps = packed_train_rows // rows_per_step
    partial = packed_train_rows % rows_per_step
    if epoch_steps < 1:
        planned = 1
        rows_scheduled = packed_train_rows
        rows_cut = 0
        rows_unseen = 0
        short = True
    else:
        planned = min(max_steps_cap, epoch_steps)
        rows_scheduled = planned * rows_per_step
        rows_cut = (epoch_steps - planned) * rows_per_step
        rows_unseen = packed_train_rows - rows_scheduled
        short = False
    illustrative_train_s = rows_scheduled * PACK_CTX / PRIOR_PADDED_TOKENS_PER_S
    return {
        "packed_train_rows": packed_train_rows,
        "rows_per_step": rows_per_step,
        "epoch_steps": epoch_steps,
        "partial_batch_rows": partial,
        "max_steps_cap": max_steps_cap,
        "planned_steps": planned,
        "rows_scheduled": rows_scheduled,
        "rows_cut_by_step_cap": rows_cut,
        "rows_unseen_if_plan_completes": rows_unseen,
        "short_of_one_step": short,
        "illustrative_train_hours": round(illustrative_train_s / 3600, 3),
        "prior_padded_tokens_per_s": PRIOR_PADDED_TOKENS_PER_S,
        "estimate": (
            "illustrative_train_hours uses the earlier 3212 padded tokens/s measurement "
            "and counts only scheduled training tokens. It leaves out startup, validation, "
            "and checkpoints. It is not a promise. The 3 hour wall clock includes those "
            "and stops the run, saving the best and latest checkpoints."
        ),
    }


def planned_steps(packed_train_rows: int) -> int:
    return schedule(packed_train_rows)["planned_steps"]
