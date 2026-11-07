"""Chat SFT for Cipher 2.0-M (369M CipherTern). Fresh trainer written for this clean set; uses only the Cipher 2.0-M model code (model.py) and checkpoint.

  python sft_train.py --data DIR --base BASE_CKPT.pt --out RUN [--resume SFT_CKPT.pt] [--stop-at N] [key=value ...]

Data: DIR/{train_x.bin,train_m.bin,val_x.bin,val_m.bin,meta.json}; rows are [1024] uint16 token ids + uint8 loss mask (1 = assistant text or <|endoftext|>).
Loss: cross-entropy ONLY on masked tokens (assistant replies + the <|endoftext|> stop token), averaged over all masked tokens of the optimizer step.
Start: model weights from the pretraining checkpoint (latest.pt['model']); optimizer is fresh. SFT checkpoints are written atomically to OUT/ckpt/{step_N.pt,latest.pt}
and resume restores model/opt/sched/scaler/step. Data order is a pure function of (seed, step), so a resumed run sees exactly the rows it would have seen.
A wall-clock guard checkpoints and exits cleanly. ON_SAVE is the same hook train.py has (used by colab_sft.py to copy to Drive / Kaggle)."""
import argparse, csv, glob, json, math, os, shutil, sys, time
from pathlib import Path
import numpy as np, torch, torch.nn.functional as F
from model import CipherTern, count_params
from common import load_tokenizer
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
from disk_preflight import REAL_DISK_NEED, require_free  # noqa: E402
from val_subset import consider_best, round_robin_indices, subset_record  # noqa: E402

DEFAULTS = dict(batch_size=4, grad_accum=8, grad_ckpt=False, lr=5e-5, min_lr_frac=0.1, warmup=30, epochs=1, max_steps=0, weight_decay=0.01, beta1=0.9, beta2=0.95, grad_clip=1.0,
                seed=1337, eval_every=100, eval_batches=100, ckpt_every=100, keep_ckpts=1, ckpt_minutes=30.0, time_limit_h=3.0, amp=True, sample_tokens=120)
ON_SAVE = None
EOT, USER, ASSISTANT, SYSTEM = 0, 2, 3, 4

def parse():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True); ap.add_argument("--base", required=True); ap.add_argument("--out", default="run")
    ap.add_argument("--resume", default=None); ap.add_argument("--stop-at", type=int, default=0); ap.add_argument("overrides", nargs="*")
    a = ap.parse_args(); cfg = dict(DEFAULTS)
    for kv in a.overrides:
        k, v = kv.split("=", 1); assert k in cfg, f"unknown setting {k}"
        cfg[k] = (v.lower() in ("1", "true")) if isinstance(cfg[k], bool) else type(cfg[k])(v)
    return a, cfg

def atomic_torch_save(obj, path: str) -> None:
    tmp = path + ".tmp"
    try:
        torch.save(obj, tmp)
        os.replace(tmp, path)
    except Exception:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def main():
    a, cfg = parse(); t_start = time.time(); dev = "cuda" if torch.cuda.is_available() else "cpu"
    if os.environ.get("SFT_ALLOW_SMALL") != "1" and not require_free(Path(a.out), REAL_DISK_NEED):
        sys.exit(2)
    cap = int(os.environ.get("SFT_MAX_STEPS_CAP", "0") or 0)
    if cap and cfg["max_steps"] > cap:
        print(f"clamping max_steps {cfg['max_steps']} to {cap}", flush=True)
        cfg["max_steps"] = cap
    meta = json.load(open(os.path.join(a.data, "meta.json"))); T = meta["ctx"]; assert T == 1024
    def mm(n, dt): return np.memmap(os.path.join(a.data, n), dtype=dt, mode="r").reshape(-1, T)
    trx, trm, vax, vam = mm("train_x.bin", np.uint16), mm("train_m.bin", np.uint8), mm("val_x.bin", np.uint16), mm("val_m.bin", np.uint8)
    N = len(trx); B, GA = cfg["batch_size"], cfg["grad_accum"]; per_step = B * GA; epoch_steps = N // per_step
    partial_rows = N % per_step
    if not cfg["max_steps"]:
        cfg["max_steps"] = epoch_steps or 1
    if epoch_steps >= 1 and cfg["max_steps"] > epoch_steps:
        print(f"clamping max_steps {cfg['max_steps']} to one epoch {epoch_steps}", flush=True)
        cfg["max_steps"] = epoch_steps
    S = cfg["max_steps"]
    rows_cut = max(0, epoch_steps - S) * per_step if epoch_steps else 0
    rows_unseen_plan = (N - S * per_step) if epoch_steps >= 1 else 0
    print(
        f"SCHEDULE packed {N} rows_per_step {per_step} epoch_steps {epoch_steps} planned_steps {S} "
        f"partial_batch_rows {partial_rows} rows_cut_by_step_cap {rows_cut} "
        f"rows_unseen_if_plan_completes {rows_unseen_plan}",
        flush=True,
    )
    print(f"device {dev} | train rows {N:,} val rows {len(vax):,} | {per_step} rows/step ({per_step*T:,} tok) | max_steps {S}", flush=True)
    torch.manual_seed(cfg["seed"])
    try:
        base = torch.load(a.base, map_location="cpu", weights_only=True)
    except Exception as exc:
        print("weights_only_refused", type(exc).__name__, exc, flush=True)
        sys.exit(2)
    mcfg = base["config"]; assert os.environ.get("SFT_ALLOW_SMALL") == "1" or (mcfg["d_model"] == 1024 and mcfg["n_layers"] == 24 and mcfg["max_len"] == 1024), f"base is not Cipher 2.0-M: {mcfg}"  # SFT_ALLOW_SMALL: tiny CPU code test only
    model = CipherTern(meta["vocab_size"], **mcfg).to(dev)
    print(f"base checkpoint {a.base}: pretrain step {base.get('step')} val_loss {base.get('val_loss')}", flush=True)
    model.load_state_dict(base["model"]); del base
    print("params total {:,} ternary {:,}".format(*count_params(model)), flush=True)
    decay = [p for n, p in model.named_parameters() if p.dim() >= 2 and "embed" not in n]; nodecay = [p for n, p in model.named_parameters() if not (p.dim() >= 2 and "embed" not in n)]
    opt = torch.optim.AdamW([{"params": decay, "weight_decay": cfg["weight_decay"]}, {"params": nodecay, "weight_decay": 0.0}], lr=cfg["lr"], betas=(cfg["beta1"], cfg["beta2"]))
    W, mf = cfg["warmup"], cfg["min_lr_frac"]
    lr_fn = lambda s: (s + 1) / W if s < W else mf + (1 - mf) * 0.5 * (1 + math.cos(math.pi * min(1.0, (s - W) / max(1, S - W))))
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lr_fn)
    if cfg["grad_ckpt"]:   # activation checkpointing per block (recompute in backward); only when training
        from torch.utils.checkpoint import checkpoint
        for l in model.layers:
            l._fwd = l.forward
            l.forward = (lambda f, mod: (lambda h: checkpoint(f, h, use_reentrant=False) if (mod.training and torch.is_grad_enabled()) else f(h)))(l._fwd, l)
    use_amp = cfg["amp"] and dev == "cuda"
    amp_dtype = torch.bfloat16 if (use_amp and torch.cuda.is_bf16_supported() and torch.cuda.get_device_capability()[0] >= 8) else torch.float16
    scaler = torch.amp.GradScaler("cuda", enabled=use_amp and amp_dtype == torch.float16)
    ckdir = os.path.join(a.out, "ckpt"); os.makedirs(ckdir, exist_ok=True); step = 0
    for c in [os.path.join(ckdir, "latest.pt"), a.resume]:
        if c and os.path.exists(c):
            try:
                ck = torch.load(c, map_location="cpu", weights_only=True)
            except Exception as exc:
                print("weights_only_refused", type(exc).__name__, exc, flush=True)
                sys.exit(2)
            if ck.get("kind") != "sft": continue
            model.load_state_dict(ck["model"]); opt.load_state_dict(ck["opt"]); sched.load_state_dict(ck["sched"]); scaler.load_state_dict(ck["scaler"]); step = ck["step"]
            print(f"RESUMED SFT from {c} at step {step} (saved val {ck.get('val_loss')})", flush=True); break
    tok = None
    try: tok, _ = load_tokenizer()
    except Exception as e: print("no tokenizer for samples:", e)
    def order(epoch):  # deterministic permutation per epoch
        return np.random.default_rng(cfg["seed"] * 1000 + epoch).permutation(N)
    _cache = {}
    def rows_for_step(s):
        idx = []; g = s * per_step
        for j in range(per_step):
            e, k = divmod(g + j, N)
            if e not in _cache: _cache.clear(); _cache[e] = order(e)
            idx.append(_cache[e][k])
        return idx
    def tensors(X, M, ix):
        ix = sorted(ix); x = torch.from_numpy(np.stack([X[i] for i in ix]).astype(np.int64)); m = torch.from_numpy(np.stack([M[i] for i in ix]).astype(np.int64))
        return x.to(dev), m.to(dev)
    def masked_ce(logits, x, m):  # predict token t+1 from t; only positions whose TARGET is masked-in count
        lg = logits[:, :-1].float(); tgt = x[:, 1:]; msk = m[:, 1:].bool()
        return F.cross_entropy(lg[msk], tgt[msk], reduction="sum"), int(msk.sum())
    val_sources = None
    src_path = os.path.join(a.data, "val_sources.json")
    if os.path.exists(src_path):
        loaded = json.load(open(src_path))
        if isinstance(loaded, list) and len(loaded) == len(vax):
            val_sources = loaded
        else:
            print("val_sources_ignored", flush=True)
    def seconds_left():
        return cfg["time_limit_h"] * 3600 - (time.time() - t_start)
    want = max(1, cfg["eval_batches"] * B)
    selection_ids = round_robin_indices(len(vax), val_sources, want)
    selection = subset_record(selection_ids)
    subset_sha = selection["sha256"]
    os.makedirs(a.out, exist_ok=True)
    subset_path = os.path.join(a.out, "val_subset.json")
    prior_subset = os.path.join(a.data, "val_subset.json")
    if os.path.exists(prior_subset):
        prior = json.load(open(prior_subset))
        if prior.get("sha256") != subset_sha or prior.get("indices") != selection_ids:
            print("val_subset_mismatch")
            sys.exit(2)
    json.dump(selection, open(subset_path, "w"), indent=2)
    print(f"VAL_SUBSET frozen count {selection['count']} sha256 {subset_sha}", flush=True)
    full_ids = list(range(len(vax)))
    @torch.no_grad()
    def evaluate(row_ids, label):
        model.eval(); tot, n = 0.0, 0; by = {}
        for start in range(0, len(row_ids), B):
            if seconds_left() <= 0:
                print(f"EVAL skipped {label} time budget", flush=True)
                model.train(); return None, {}
            ix = sorted(row_ids[start:start + B])
            x, m = tensors(vax, vam, ix)
            with torch.autocast("cuda", dtype=amp_dtype, enabled=use_amp): lg = model(x)
            lgf = lg[:, :-1].float(); tgt = x[:, 1:]; msk = m[:, 1:].bool()
            for i, row_i in enumerate(ix):
                if not bool(msk[i].any()):
                    continue
                loss_i = F.cross_entropy(lgf[i][msk[i]], tgt[i][msk[i]], reduction="sum")
                count_i = int(msk[i].sum()); tot += loss_i.item(); n += count_i
                name = str(val_sources[row_i]) if val_sources else ""
                slot = by.setdefault(name, [0.0, 0])
                slot[0] += loss_i.item(); slot[1] += count_i
        model.train()
        summary = {k: round(v[0] / v[1], 6) for k, v in sorted(by.items()) if v[1]}
        if summary:
            print(f"EVAL_BY_SOURCE {label} " + json.dumps(summary), flush=True)
        return (tot / n) if n else None, summary
    def greedy_reply(user_text):
        if tok is None: return ""
        model.eval(); enc = lambda t: tok.encode(t, add_special_tokens=False).ids
        sys = "You are Cipher, a helpful assistant. Answer the user clearly and accurately. If you do not know, say so.\n"
        ids = [SYSTEM] + enc(sys) + [USER] + enc(user_text.rstrip() + "\n") + [ASSISTANT]
        out = model.generate(torch.tensor([ids], device=dev), 64, 1.0, 1, eos_id=EOT)[0].tolist()[len(ids):]
        model.train(); return tok.decode([t for t in out if t != EOT], skip_special_tokens=False)
    def sample():
        probe = os.environ.get("SFT_PROBE_FILE")
        if not probe: return ""
        try:
            spec = json.load(open(probe))
        except OSError:
            return ""
        bits = []
        for item in spec.get("probes", []):
            text = greedy_reply(item["text"])
            bits.append(item["id"] + ": " + text.replace("\n", " "))
            low = text.lower()
            if any(b in low for b in ("front desk", "call 911", "on file for this hotel", "late checkout")):
                bits.append("HOTEL_TEMPLATE")
            if item["id"] == "p-format" and len(text.split()) > 8:
                bits.append("RAMBLE")
        return " | ".join(bits)
    best = None
    full_eval_s = None
    selection_loss = None
    full_val_loss = None
    def save(update_best: bool):
        ck = dict(kind="sft", model=model.state_dict(), opt=opt.state_dict(), sched=sched.state_dict(), scaler=scaler.state_dict(), step=step, config=mcfg, sft_config=cfg, meta=meta, selection_loss=selection_loss, full_val_loss=full_val_loss, selection_subset_sha256=subset_sha, best_step=None if best is None else best["step"])
        latest = os.path.join(ckdir, "latest.pt")
        atomic_torch_save(ck, latest)
        updated = False
        if update_best:
            new_best, updated = consider_best(best, step, selection_loss)
            if updated:
                prev = None if best is None else best["step"]
                best_ck = dict(ck)
                best_ck["best_step"] = step
                atomic_torch_save(best_ck, os.path.join(ckdir, "best.pt"))
                role = "base" if step == 0 else "update"
                print(f"BEST step {step} subset_loss {selection_loss:.6f} subset_sha256 {subset_sha} role {role} replaces {prev}", flush=True)
                nonlocal_best(new_best)
            elif selection_loss is not None and best is not None:
                print(f"BEST unchanged step {best['step']} subset_loss {best['subset_loss']:.6f} candidate_step {step} candidate_subset_loss {selection_loss:.6f} subset_sha256 {subset_sha}", flush=True)
        if cfg["keep_ckpts"] > 1:
            shutil.copyfile(latest, os.path.join(ckdir, f"step_{step:07d}.pt"))
        for old in sorted(glob.glob(os.path.join(ckdir, "step_*.pt")))[:-cfg["keep_ckpts"]] if cfg["keep_ckpts"] > 1 else []:
            os.remove(old)
        print(f"CHECKPOINT step {step} -> {latest}", flush=True)
        if ON_SAVE: ON_SAVE()
        return updated
    def nonlocal_best(value):
        nonlocal best
        best = value
    def run_selection():
        nonlocal selection_loss
        score, _summary = evaluate(selection_ids, "selection")
        if score is not None:
            selection_loss = score
        return score
    def run_full():
        nonlocal full_val_loss, full_eval_s
        started = time.time()
        score, _summary = evaluate(full_ids, "full")
        if score is None:
            return None
        full_eval_s = time.time() - started
        full_val_loss = score
        print(f"FULL_VAL step {step} loss {score:.6f} rows {len(full_ids)} not_used_for_best", flush=True)
        return score
    json.dump(cfg, open(os.path.join(a.out, "config.json"), "w"), indent=1)
    logf = open(os.path.join(a.out, "log.csv"), "a", newline=""); lw = csv.writer(logf)
    if logf.tell() == 0: lw.writerow(["step", "lr", "train_loss", "selection_loss", "full_val_loss", "tokens_per_s", "elapsed_s"])
    model.train(); t0 = time.time(); toks = 0; last_save = time.time(); stop_at = min(a.stop_at or S, S)
    stopped_reason = "plan"
    if step == 0 and seconds_left() > 0:
        score = run_selection()
        if score is not None:
            print(f"EVAL step 0 selection subset_loss {score:.6f} subset_sha256 {subset_sha}", flush=True)
        if seconds_left() > 0:
            run_full()
        lw.writerow([0, 0, "", selection_loss if selection_loss is not None else "", full_val_loss if full_val_loss is not None else "", 0, 0]); logf.flush()
        save(update_best=True)
    while step < stop_at:
        if seconds_left() <= 0:
            stopped_reason = "timeout"
            save(update_best=False)
            print("WALL-CLOCK GUARD: saved latest, best unchanged unless a finished subset score already won", flush=True)
            break
        ix = rows_for_step(step); ntok = int(sum(int(trm[i][1:].sum()) for i in ix)); acc = 0.0
        for k in range(GA):
            x, m = tensors(trx, trm, ix[k * B:(k + 1) * B])
            with torch.autocast("cuda", dtype=amp_dtype, enabled=use_amp): lg = model(x)
            ls, c = masked_ce(lg, x, m); loss = ls / max(1, ntok)   # token-weighted over the whole optimizer step
            scaler.scale(loss).backward(); acc += loss.item(); toks += x.numel()
        scaler.unscale_(opt); gn = torch.nn.utils.clip_grad_norm_(model.parameters(), cfg["grad_clip"])
        scaler.step(opt); scaler.update(); opt.zero_grad(set_to_none=True); sched.step(); step += 1
        timed_out = seconds_left() <= 0
        if step % 10 == 0 or step == 1:
            el = time.time() - t_start
            shown = f"{selection_loss:.4f}" if selection_loss is not None else "-"
            print(f"step {step} loss {acc:.4f} selection {shown} lr {sched.get_last_lr()[0]:.2e} gnorm {float(gn):.2f} tok/s {toks/(time.time()-t0):,.0f} elapsed {el/3600:.2f}h", flush=True)
        if step % cfg["eval_every"] == 0 and step != stop_at and not timed_out:
            score = run_selection()
            if score is not None:
                print(f"EVAL step {step} selection train {acc:.4f} subset_loss {score:.6f}", flush=True)
                lw.writerow([step, sched.get_last_lr()[0], acc, score, "", round(toks / (time.time() - t0)), round(time.time() - t_start)]); logf.flush()
                save(update_best=True); last_save = time.time()
        if step == stop_at or timed_out:
            if timed_out:
                print("WALL-CLOCK GUARD: subset score only if it finishes, full validation is not required", flush=True)
                stopped_reason = "timeout"
                if seconds_left() > 0:
                    run_selection()
            else:
                run_selection()
                need = 30.0 if full_eval_s is None else max(30.0, full_eval_s * 1.5)
                if seconds_left() > need:
                    run_full()
                else:
                    print("END full validation skipped because the clock would not cover it", flush=True)
                lw.writerow([step, sched.get_last_lr()[0], acc, selection_loss if selection_loss is not None else "", full_val_loss if full_val_loss is not None else "", round(toks / (time.time() - t0)), round(time.time() - t_start)]); logf.flush()
            save(update_best=not timed_out or selection_loss is not None); last_save = time.time()
            if stopped_reason == "timeout":
                break
        elif step % cfg["ckpt_every"] == 0 or time.time() - last_save > cfg["ckpt_minutes"] * 60:
            save(update_best=False); last_save = time.time()
            probed = sample(); print("SAMPLE:", repr(probed), flush=True)
            if "HOTEL_TEMPLATE" in probed or "RAMBLE" in probed:
                print("PROBE STOP: hotel template or ramble", flush=True); stopped_reason = "probe"; break
    if epoch_steps:
        rows_seen = min(N, step * per_step)
        rows_not_seen = N - rows_seen
    else:
        rows_seen, rows_not_seen = N, 0
    print(f"SCHEDULE_END steps {step} rows_seen {rows_seen} rows_not_seen {rows_not_seen} partial_batch_rows {partial_rows} reason {stopped_reason}", flush=True)
    logf.close()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    print("TRAIN DONE step", step, flush=True)

if __name__ == "__main__":
    main()
