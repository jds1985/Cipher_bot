import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { CipherDb } from '../main/db';
import { toNewBot, formToProfile } from '../main/createBot';
import { defaultDroneFor, parseStoredDrone } from '../shared/droneTheme';
import { presetSpec, sanitizeSpec } from '../shared/droneParts';

const tmp = (): string => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cipher-drone-')), 'cipher.db');
const nb = (name: string, systemPrompt = '', drone?: unknown) => ({ name, systemPrompt, toolsEnabled: false, folderPath: null, ...(drone ? { drone } : {}) });

test('drone migration: an older database gets the drone column and deterministic specs; idempotent', () => {
  const file = tmp();
  let db = new CipherDb(file);
  for (const [n, j] of [['Cipher', ''], ['Researcher', ''], ['Hoops coach', 'Help me with basketball drills'], ['Ada', 'You help.'], ['Bo', '']]) db.createBot(nb(n, j));
  db.close();
  // Simulate a v1.25 database: no drone column at all.
  let raw = new Database(file);
  raw.exec('ALTER TABLE bots DROP COLUMN drone');
  raw.close();
  db = new CipherDb(file);
  const bots = db.listBots();
  const by = (n: string) => bots.find((b) => b.name === n)!;
  assert.deepEqual(by('Cipher').drone, presetSpec('cipher'));
  assert.deepEqual(by('Researcher').drone, presetSpec('researcher'));
  assert.equal(by('Hoops coach').drone.shell, 'basketball');
  assert.deepEqual(by('Ada').drone, defaultDroneFor({ id: by('Ada').id, name: 'Ada', systemPrompt: 'You help.' }));
  assert.notDeepEqual(by('Ada').drone, by('Bo').drone, 'neighbours get different presets');
  const stored = (new Database(file).prepare('SELECT id, drone FROM bots ORDER BY id').all() as { id: number; drone: string }[]);
  for (const r of stored) assert.deepEqual(parseStoredDrone(r.drone), bots.find((b) => b.id === r.id)!.drone, 'persisted, not just computed');
  db.close();
  db = new CipherDb(file); // again: nothing changes
  assert.deepEqual(db.listBots().map((b) => b.drone), bots.map((b) => b.drone));
  db.close();
});

test('drone persistence: create with a builder spec, edit replaces it, edit without drone keeps it; garbage sanitized', () => {
  const db = new CipherDb(tmp());
  const spec = { shell: 'basketball', palette: 'orange', eye: 'ring', fins: 'blade', crystal: 'gem', accessories: ['hoop', 'headphones'] };
  const a = db.createBot(toNewBot({ name: 'Coach', job: '', shape: 'hex', color: 'blue', drone: spec as never }));
  assert.deepEqual(a.drone, spec);
  const b = db.updateBot(a.id, formToProfile({ name: 'Coach', job: 'x', shape: 'hex', color: 'blue', drone: presetSpec('error') }));
  assert.deepEqual(b.drone, presetSpec('error'));
  const c = db.updateBot(a.id, formToProfile({ name: 'Coach 2', job: 'x', shape: 'hex', color: 'blue' }));
  assert.deepEqual(c.drone, presetSpec('error'), 'unchanged when the form sends no drone');
  const d = db.createBot(nb('Evil', '', { shell: '<script>', palette: '__proto__', accessories: ['x', 'halo'] }));
  assert.deepEqual(d.drone, sanitizeSpec({ accessories: ['halo'] }));
  // a garbled stored value falls back to the default on read and is repaired on next open
  const file = (db as unknown as { db: { name: string } }).db.name;
  db.close();
  const raw = new Database(file); raw.prepare('UPDATE bots SET drone = ? WHERE id = ?').run('{not json', d.id); raw.close();
  const db2 = new CipherDb(file);
  assert.deepEqual(db2.getBot(d.id)!.drone, defaultDroneFor({ id: d.id, name: 'Evil', systemPrompt: '' }));
  db2.close();
  assert.match(new Database(file).prepare('SELECT drone FROM bots WHERE id = ?').pluck().get(d.id) as string, /^\{"shell"/);
});

test('create without a drone: default follows the name/job', () => {
  const db = new CipherDb(tmp());
  assert.deepEqual(db.createBot(nb('My Cipher')).drone, presetSpec('cipher'));
  assert.equal(db.createBot(nb('Chef', 'Coffee and espresso tips')).drone.accessories[0], 'steam');
  db.close();
});
