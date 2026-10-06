import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toNewBot } from '../main/createBot';
import { CipherDb } from '../main/db';
import type { SetupState } from '../shared/types';

// The renderer's pure view module is an ES module; Electron's Node can require() it directly.
interface ViewModule {
  decideView(i: { botCount: number; formOpen: boolean; setup: SetupState }): 'form' | 'setup' | 'chat';
  setupCopy(s: SetupState): { text: string; detail: string | null; showProgress: boolean; showGetEngine: boolean; retryLabel: string | null };
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const view = require('../renderer/view.js') as ViewModule;

const st = (phase: SetupState['phase'], extra: Partial<SetupState> = {}): SetupState =>
  ({ phase, percent: null, completed: 0, total: 0, message: null, ...extra });

test('"Create a Cipher bot" Name + Job: Job becomes the system prompt, file reading off, no folder', () => {
  assert.deepEqual(toNewBot({ name: 'Planner', job: '  Help me plan my week.  ' }), {
    name: 'Planner', systemPrompt: 'Help me plan my week.', toolsEnabled: false, folderPath: null,
  });
  // Extra fields from the renderer can't turn tools on or attach a folder at creation.
  assert.equal(toNewBot({ name: 'x', job: '', toolsEnabled: true, folderPath: '/etc' } as never).toolsEnabled, false);
  assert.equal(toNewBot({ name: 'x', job: '', toolsEnabled: true, folderPath: '/etc' } as never).folderPath, null);
});

test('a created Cipher bot is stored with tools off by default and its job as the system prompt', () => {
  const db = new CipherDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cipher-create-')), 'c.db'));
  const bot = db.createBot(toNewBot({ name: 'Notes', job: 'Summarize my notes.' }));
  assert.equal(bot.toolsEnabled, false);
  assert.equal(bot.folderPath, null);
  assert.equal(bot.systemPrompt, 'Summarize my notes.');
  assert.throws(() => db.createBot(toNewBot({ name: ' ', job: 'x' })), /give your Cipher bot a name/);
  db.close();
});

test('first-run detection: with no Cipher bots the first screen is "Create a Cipher bot", whatever setup is doing', () => {
  for (const phase of ['checking', 'downloading', 'engine-missing', 'model-missing', 'error', 'ready'] as const) {
    assert.equal(view.decideView({ botCount: 0, formOpen: false, setup: st(phase) }), 'form', phase);
  }
});

test('after the first Cipher bot exists: setup screen until ready; never blocks on "checking"', () => {
  assert.equal(view.decideView({ botCount: 1, formOpen: false, setup: st('downloading') }), 'setup');
  assert.equal(view.decideView({ botCount: 1, formOpen: false, setup: st('engine-missing') }), 'setup');
  assert.equal(view.decideView({ botCount: 1, formOpen: false, setup: st('model-missing') }), 'setup');
  assert.equal(view.decideView({ botCount: 1, formOpen: false, setup: st('error') }), 'setup');
  assert.equal(view.decideView({ botCount: 1, formOpen: false, setup: st('checking') }), 'chat');
  assert.equal(view.decideView({ botCount: 1, formOpen: false, setup: st('ready') }), 'chat');
  assert.equal(view.decideView({ botCount: 1, formOpen: true, setup: st('ready') }), 'form');
});

test('setup screen copy: progress while downloading, actionable buttons otherwise, no engine/model names', () => {
  const dl = view.setupCopy(st('downloading', { percent: 42.7, completed: 2e9, total: 4.7e9 }));
  assert.equal(dl.showProgress, true);
  assert.equal(dl.detail, '42% · 2.0 GB of 4.7 GB');
  assert.equal(dl.retryLabel, null);
  assert.equal(view.setupCopy(st('downloading')).detail, 'Starting…');
  const engine = view.setupCopy(st('engine-missing', { message: 'm' }));
  assert.equal(engine.showGetEngine, true);
  assert.equal(engine.retryLabel, 'Check again');
  assert.equal(view.setupCopy(st('model-missing', { message: 'm' })).retryLabel, 'Set up again');
  assert.equal(view.setupCopy(st('error', { message: 'm' })).retryLabel, 'Try again');
  for (const c of [dl, engine]) assert.doesNotMatch(c.text + (c.detail ?? ''), /ollama|qwen/i);
});
