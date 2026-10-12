// v1.23: one-time local reminders. A reminder sends its prompt to one Cipher bot's chat at a local date and time,
// through a main-process timer (no OS scheduler, no network). Like routines, it runs only while Cipher Bot is open or
// in the tray. MISSED REMINDERS ARE SKIPPED, NOT CAUGHT UP: if Cipher Bot wasn't running (or the chat stayed busy) for
// REMINDER_GRACE_MS after the time, the reminder is marked "missed" and never runs later. An archived bot's reminder
// is marked "skipped" at its time. Reminder turns run like routines: no web search, no write-file, no checklist; only
// read_file and the calculator, and only if that bot's switches allow them.
import type { Reminder } from '../shared/types';

export const REMINDERS_MAX = 50;
export const REMINDER_PROMPT_MAX = 2000;
/** How late a reminder may still start (the scheduler checks several times a minute). */
export const REMINDER_GRACE_MS = 2 * 60_000;
export const REMINDER_CHECK_MS = 15_000;

const AT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** "YYYY-MM-DDTHH:MM" (local time) → Date, or null if malformed or not a real date. */
export function parseReminderAt(at: unknown): Date | null {
  if (typeof at !== 'string') return null;
  const m = AT_RE.exec(at);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const dt = new Date(y, mo - 1, d, h, mi, 0, 0);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d || dt.getHours() !== h || dt.getMinutes() !== mi) return null;
  return dt;
}

export function validateReminder(at: unknown, prompt: unknown, now: Date = new Date()): { at: string; prompt: string } {
  const when = parseReminderAt(at);
  if (!when) throw new Error('Pick a date and a time.');
  if (when.getTime() <= now.getTime()) throw new Error('Pick a time in the future.');
  if (when.getTime() - now.getTime() > 366 * 24 * 3600_000) throw new Error('Reminders can be set up to a year ahead.');
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Write what the reminder should send.');
  const p = prompt.replace(/\r\n?/g, '\n').trim();
  if (p.length > REMINDER_PROMPT_MAX) throw new Error(`Reminder messages are up to ${REMINDER_PROMPT_MAX} characters.`);
  return { at: at as string, prompt: p };
}

/** 'wait' (not yet), 'due' (start now), or 'missed' (too late: skipped, never caught up). */
export function reminderState(r: Pick<Reminder, 'at' | 'status'>, now: Date): 'wait' | 'due' | 'missed' | 'done' {
  if (r.status !== 'pending') return 'done';
  const when = parseReminderAt(r.at);
  if (!when) return 'missed';
  const late = now.getTime() - when.getTime();
  if (late < 0) return 'wait';
  return late <= REMINDER_GRACE_MS ? 'due' : 'missed';
}

export interface ReminderDeps {
  listPending(): Reminder[];
  /** null if the bot is gone. */
  bot(botId: number): { archived: boolean } | null;
  chatIdForBot(botId: number): number;
  isBusy(chatId: number): boolean;
  setStatus(id: number, status: Reminder['status'], note: string | null): void;
  /** Start the turn (main: like a routine; marked as a reminder). */
  run(reminder: Reminder, chatId: number): void;
  now?: () => Date;
}

export class ReminderScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private deps: ReminderDeps) {}

  /** Returns the ids started. A busy chat is retried until the grace period ends, then marked missed. */
  tick(): number[] {
    const now = (this.deps.now ?? (() => new Date()))();
    const started: number[] = [];
    for (const r of this.deps.listPending()) {
      const st = reminderState(r, now);
      if (st === 'wait' || st === 'done') continue;
      if (st === 'missed') { this.deps.setStatus(r.id, 'missed', 'Cipher Bot was not running (or the chat was busy) at that time; skipped.'); continue; }
      const bot = this.deps.bot(r.botId);
      if (!bot) { this.deps.setStatus(r.id, 'skipped', 'The Cipher bot is gone.'); continue; }
      if (bot.archived) { this.deps.setStatus(r.id, 'skipped', 'The Cipher bot was archived; skipped.'); continue; }
      let chatId: number;
      try { chatId = this.deps.chatIdForBot(r.botId); } catch { continue; }
      if (this.deps.isBusy(chatId)) continue;
      this.deps.setStatus(r.id, 'done', null); // recorded before starting, so it never runs twice
      this.deps.run(r, chatId);
      started.push(r.id);
    }
    return started;
  }

  start(intervalMs = REMINDER_CHECK_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => { try { this.tick(); } catch { /* keep the timer alive */ } }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
