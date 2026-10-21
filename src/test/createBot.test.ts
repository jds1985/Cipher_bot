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
  decideView(i: { botCount: number; formOpen: boolean; roomFormOpen?: boolean; settingsOpen?: boolean; setup: SetupState }): 'form' | 'room-form' | 'settings' | 'setup' | 'chat';
  setupCopy(s: SetupState): { text: string; detail: string | null; retryLabel: string | null };
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const view = require('../renderer/view.js') as ViewModule;

const st = (phase: SetupState['phase'], extra: Partial<SetupState> = {}): SetupState =>
  ({ phase, message: null, model: null, toolCalling: false, ...extra });

test('"Create a Cipher bot" Name + Job: Job becomes the system prompt, file reading off, no folder', () => {
  assert.deepEqual(toNewBot({ name: 'Planner', job: '  Help me plan my week.  ', shape: 'chip', color: 'cyan' }), {
    name: 'Planner', systemPrompt: 'Help me plan my week.', toolsEnabled: false, folderPath: null, shape: 'chip', color: 'cyan',
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
  for (const phase of ['checking', 'starting', 'error', 'ready'] as const) {
    assert.equal(view.decideView({ botCount: 0, formOpen: false, setup: st(phase) }), 'form', phase);
  }
});

test('after the first Cipher bot exists: the model screen only on error; never blocks on "checking" or "starting"', () => {
  assert.equal(view.decideView({ botCount: 1, formOpen: false, setup: st('starting') }), 'chat');
  assert.equal(view.decideView({ botCount: 1, formOpen: false, setup: st('error') }), 'setup');
  assert.equal(view.decideView({ botCount: 1, formOpen: false, setup: st('checking') }), 'chat');
  assert.equal(view.decideView({ botCount: 1, formOpen: false, setup: st('ready') }), 'chat');
  assert.equal(view.decideView({ botCount: 1, formOpen: true, setup: st('ready') }), 'form');
  assert.equal(view.decideView({ botCount: 2, formOpen: false, roomFormOpen: true, setup: st('ready') }), 'room-form');
  assert.equal(view.decideView({ botCount: 0, formOpen: false, roomFormOpen: true, setup: st('ready') }), 'form', 'first run still creates a bot');
  assert.equal(view.decideView({ botCount: 1, formOpen: false, settingsOpen: true, setup: st('ready') }), 'settings');
});

test('model screen copy: plain words, a retry only on error, no download or install step, no third-party names', () => {
  assert.deepEqual(view.setupCopy(st('error', { message: 'm' })), { text: 'm', detail: null, retryLabel: 'Try again' });
  assert.equal(view.setupCopy(st('starting')).text, 'Starting the Cipher model…');
  assert.equal(view.setupCopy(st('starting')).retryLabel, null);
  assert.equal(view.setupCopy(st('ready', { model: 'Cipher 2.0 (135M stand-in)' })).detail, 'Cipher 2.0 (135M stand-in)');
  for (const p of ['checking', 'starting', 'error', 'ready'] as const) {
    const c = view.setupCopy(st(p));
    assert.doesNotMatch(c.text + (c.detail ?? '') + (c.retryLabel ?? ''), /ollama|qwen|download|install|engine/i);
  }
});
