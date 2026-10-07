// Local routine (v1.9): one Cipher bot sends itself a saved prompt every day at a time the user picks.
// Runs only in this process (a main-process timer) while Cipher is open or in the tray. No OS scheduler,
// no autostart, no network of its own: the turn goes to the local model like any chat, with file reading off.
import type { Routine } from '../shared/types';

/** Longest routine prompt: the same limit as a bot's job (system prompt). */
export const MAX_ROUTINE_PROMPT = 20000;
/** How often the scheduler checks the clock. Several checks per minute, so the chosen minute is never missed. */
export const ROUTINE_CHECK_MS = 20_000;

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** True for a 24-hour local time "HH:MM" (00:00–23:59). */
export const isRoutineTime = (v: unknown): v is string => typeof v === 'string' && TIME_RE.test(v);

export interface RoutineInput {
  prompt: string;
  time: string;
  enabled: boolean;
}

/**
 * The one validator for a routine (used by CipherDb.setRoutine, so IPC and tests share it). The prompt is trimmed
 * and must be 1–20000 characters; the time must be "HH:MM" (24-hour, local). Throws a plain-language Error.
 */
export function validateRoutine(input: { prompt?: unknown; time?: unknown; enabled?: unknown } | null | undefined): RoutineInput {
  const prompt = String(input?.prompt ?? '').trim();
  if (!prompt) throw new Error('Please write the message this routine should send.');
  if (prompt.length > MAX_ROUTINE_PROMPT) throw new Error(`The routine message is too long (max ${MAX_ROUTINE_PROMPT} characters).`);
  const time = typeof input?.time === 'string' ? input.time.trim() : '';
  if (!isRoutineTime(time)) throw new Error('Please pick a time as HH:MM (24-hour), for example 08:30.');
  return { prompt, time, enabled: input?.enabled === true };
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** The local calendar day of a moment, "YYYY-MM-DD" (used as the routine's last-run marker). */
export const localDateKey = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** The local time of a moment, "HH:MM". */
export const localTimeKey = (d: Date): string => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/**
 * Due only during the chosen minute itself, at most once per local day. No catch-up: if Cipher wasn't running
 * (or the chat was busy) for that whole minute, that day's run is skipped and the next one is tomorrow.
 */
export function isRoutineDue(r: Pick<Routine, 'time' | 'enabled' | 'lastRunDate'>, now: Date): boolean {
  if (!r.enabled || !isRoutineTime(r.time)) return false;
  if (r.lastRunDate === localDateKey(now)) return false;
  return localTimeKey(now) === r.time;
}

export interface SchedulerDeps {
  listRoutines(): Routine[];
  /** The bot's one chat id (created on first use). */
  chatIdForBot(botId: number): number;
  /** True while that chat is already replying (desktop, phone or another routine). */
  isBusy(chatId: number): boolean;
  /** Record today's run before starting it, so a run never happens twice. */
  markRun(botId: number, dateKey: string): void;
  /** Start the turn (main.ts: tools off, message marked as from the routine). */
  run(botId: number, chatId: number, prompt: string): void;
  now?: () => Date;
}

/** Checks the clock on a timer and starts due routines. tick() is exposed for tests (injected clock). */
export class RoutineScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private deps: SchedulerDeps) {}

  /** Start every due routine whose chat is free; returns the bot ids started. A busy chat is retried on the next tick. */
  tick(): number[] {
    const now = (this.deps.now ?? (() => new Date()))();
    const started: number[] = [];
    for (const r of this.deps.listRoutines()) {
      if (!isRoutineDue(r, now)) continue;
      let chatId: number;
      try { chatId = this.deps.chatIdForBot(r.botId); } catch { continue; }
      if (this.deps.isBusy(chatId)) continue;
      this.deps.markRun(r.botId, localDateKey(now));
      this.deps.run(r.botId, chatId, r.prompt);
      started.push(r.botId);
    }
    return started;
  }

  start(intervalMs = ROUTINE_CHECK_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => { try { this.tick(); } catch { /* keep the timer alive */ } }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
