import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRoutineDue, isRoutineTime, localDateKey, MAX_ROUTINE_PROMPT, RoutineScheduler, validateRoutine } from '../main/routine';
import type { Routine } from '../shared/types';

// Local times, so the checks hold in any time zone.
const at = (d: number, h: number, m: number, s = 0) => new Date(2026, 9, d, h, m, s);

test('validateRoutine: trimmed non-empty prompt up to the limit, strict 24-hour HH:MM, enabled only when true', () => {
  assert.deepEqual(validateRoutine({ prompt: '  Plan my day  ', time: '08:30', enabled: true }), { prompt: 'Plan my day', time: '08:30', enabled: true });
  assert.equal(validateRoutine({ prompt: 'x', time: '23:59', enabled: 'yes' }).enabled, false);
  assert.equal(validateRoutine({ prompt: 'x'.repeat(MAX_ROUTINE_PROMPT), time: '00:00' }).prompt.length, MAX_ROUTINE_PROMPT);
  assert.throws(() => validateRoutine({ prompt: '   ', time: '08:00' }), /write the message/);
  assert.throws(() => validateRoutine({ prompt: 'x'.repeat(MAX_ROUTINE_PROMPT + 1), time: '08:00' }), /too long/);
  assert.throws(() => validateRoutine(null), /write the message/);
  for (const bad of ['8:00', '24:00', '12:60', '12-30', '', '08:00:00', ' 08:0', 830, null]) {
    assert.throws(() => validateRoutine({ prompt: 'x', time: bad }), /HH:MM/, String(bad));
    assert.equal(isRoutineTime(bad), false, String(bad));
  }
});

test('isRoutineDue: only during the chosen local minute, only when on, at most once per local day', () => {
  const r = { time: '08:30', enabled: true, lastRunDate: null };
  assert.equal(isRoutineDue(r, at(7, 8, 30, 0)), true);
  assert.equal(isRoutineDue(r, at(7, 8, 30, 59)), true);
  assert.equal(isRoutineDue(r, at(7, 8, 29, 59)), false, 'not early');
  assert.equal(isRoutineDue(r, at(7, 8, 31, 0)), false, 'no catch-up after the minute');
  assert.equal(isRoutineDue(r, at(7, 20, 0)), false, 'no catch-up later in the day');
  assert.equal(isRoutineDue({ ...r, enabled: false }, at(7, 8, 30)), false, 'off');
  assert.equal(isRoutineDue({ ...r, lastRunDate: localDateKey(at(7, 1, 0)) }, at(7, 8, 30)), false, 'already ran today');
  assert.equal(isRoutineDue({ ...r, lastRunDate: localDateKey(at(6, 8, 30)) }, at(7, 8, 30)), true, 'ran yesterday');
});

function harness(routines: Routine[], opts: { busy?: Set<number> } = {}) {
  let now = at(7, 8, 0);
  const runs: { botId: number; chatId: number; prompt: string; at: Date }[] = [];
  const busy = opts.busy ?? new Set<number>();
  const s = new RoutineScheduler({
    listRoutines: () => routines.map((r) => ({ ...r })),
    chatIdForBot: (botId) => botId * 10,
    isBusy: (chatId) => busy.has(chatId),
    markRun: (botId, dateKey) => { routines.find((r) => r.botId === botId)!.lastRunDate = dateKey; },
    run: (botId, chatId, prompt) => runs.push({ botId, chatId, prompt, at: now }),
    now: () => now,
  });
  return { s, runs, busy, setNow: (d: Date) => { now = d; } };
}

test('scheduler: runs once at the chosen minute even with several ticks; next day again', () => {
  const routines: Routine[] = [{ botId: 1, prompt: 'Plan', time: '08:30', enabled: true, lastRunDate: null }];
  const h = harness(routines);
  for (const [hh, mm, ss] of [[8, 29, 40], [8, 30, 0], [8, 30, 20], [8, 30, 40], [8, 31, 0]] as const) {
    h.setNow(at(7, hh, mm, ss));
    h.s.tick();
  }
  assert.deepEqual(h.runs.map((r) => [r.botId, r.chatId, r.prompt]), [[1, 10, 'Plan']], 'no double run');
  assert.equal(routines[0].lastRunDate, '2026-10-07');
  h.setNow(at(8, 8, 30, 5));
  assert.deepEqual(h.s.tick(), [1], 'runs the next day');
  assert.equal(h.runs.length, 2);
});

test('scheduler: no catch-up when Cipher starts after the time; disabled routines never run', () => {
  const routines: Routine[] = [
    { botId: 1, prompt: 'A', time: '08:30', enabled: true, lastRunDate: null },
    { botId: 2, prompt: 'B', time: '09:00', enabled: false, lastRunDate: null },
  ];
  const h = harness(routines);
  // Cipher "starts" at 08:45 and keeps ticking for the rest of the day.
  for (let m = 45; m < 24 * 60; m += 7) { h.setNow(at(7, Math.floor(m / 60), m % 60)); h.s.tick(); }
  assert.equal(h.runs.length, 0);
  assert.equal(routines[0].lastRunDate, null, 'a skipped day is not recorded as run');
});

test('scheduler: a busy chat is retried within the minute, then skipped for the day; other bots are unaffected', () => {
  const routines: Routine[] = [
    { botId: 1, prompt: 'A', time: '08:30', enabled: true, lastRunDate: null },
    { botId: 2, prompt: 'B', time: '08:30', enabled: true, lastRunDate: null },
  ];
  const h = harness(routines, { busy: new Set([10]) });
  h.setNow(at(7, 8, 30, 0));
  assert.deepEqual(h.s.tick(), [2], 'bot 1 busy, bot 2 runs');
  h.busy.clear();
  h.setNow(at(7, 8, 30, 40));
  assert.deepEqual(h.s.tick(), [1], 'bot 1 runs once its chat is free, same minute');
  // Busy for the whole minute → skipped.
  const r2: Routine[] = [{ botId: 3, prompt: 'C', time: '10:00', enabled: true, lastRunDate: null }];
  const h2 = harness(r2, { busy: new Set([30]) });
  for (const s of [0, 20, 40]) { h2.setNow(at(7, 10, 0, s)); h2.s.tick(); }
  h2.busy.clear();
  h2.setNow(at(7, 10, 1, 0));
  h2.s.tick();
  assert.equal(h2.runs.length, 0);
});

test('scheduler: a bot that disappeared mid-tick is skipped without stopping the others', () => {
  const routines: Routine[] = [
    { botId: 1, prompt: 'A', time: '08:30', enabled: true, lastRunDate: null },
    { botId: 2, prompt: 'B', time: '08:30', enabled: true, lastRunDate: null },
  ];
  const runs: number[] = [];
  const s = new RoutineScheduler({
    listRoutines: () => routines,
    chatIdForBot: (botId) => { if (botId === 1) throw new Error('Cipher bot not found.'); return 20; },
    isBusy: () => false,
    markRun: () => {},
    run: (botId) => runs.push(botId),
    now: () => at(7, 8, 30),
  });
  assert.deepEqual(s.tick(), [2]);
  assert.deepEqual(runs, [2]);
});
