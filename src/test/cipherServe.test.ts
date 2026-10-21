import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CipherServer, MODEL_FILE_MISSING_MESSAGE, START_FAILED_MESSAGE, defaultThreads, resolveServerPaths } from '../main/cipherServe';
import { looksLikeDevBuild, parseManifest } from '../main/modelManifest';
import { streamChat } from '../main/backend';

const repo = path.join(__dirname, '..', '..');
const realPaths = resolveServerPaths({ isPackaged: false, resourcesPath: '/nope', appPath: repo });
const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'resources', 'model', 'manifest.json'), 'utf8'));
const haveReal = fs.existsSync(realPaths.binary) && fs.existsSync(path.join(realPaths.modelDir, manifest.file));
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async (fn: () => boolean, ms = 8000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 25)); } };

test('paths: packaged → resources/{bin,model}; dev → repo resources/bin/<electron-builder os-arch>', () => {
  assert.deepEqual(resolveServerPaths({ isPackaged: true, resourcesPath: '/opt/Cipher/resources', appPath: '/x', platform: 'linux', arch: 'x64' }),
    { binary: '/opt/Cipher/resources/bin/cipher-serve', modelDir: '/opt/Cipher/resources/model' });
  assert.equal(resolveServerPaths({ isPackaged: false, resourcesPath: '', appPath: '/r', platform: 'linux', arch: 'x64' }).binary, '/r/resources/bin/linux-x64/cipher-serve');
  assert.equal(resolveServerPaths({ isPackaged: false, resourcesPath: '', appPath: '/r', platform: 'darwin', arch: 'arm64' }).binary, '/r/resources/bin/mac-arm64/cipher-serve');
  assert.equal(path.basename(resolveServerPaths({ isPackaged: true, resourcesPath: 'C:\\R', appPath: '', platform: 'win32', arch: 'x64' }).binary), 'cipher-serve.exe');
  assert.ok(defaultThreads(8) === 7 && defaultThreads(2) === 2 && defaultThreads(64) === 8);
});

test('the bundled manifest is the public 135M stand-in; dev/private builds are refused everywhere', () => {
  const m = parseManifest(manifest);
  assert.equal(m.build, 'public');
  assert.equal(m.nCtx, 1024);
  assert.equal(m.capabilities.toolCalling, false, '135M: no tool calling');
  assert.ok(m.maxReplyTokens < m.nCtx);
  for (const bad of [{ ...manifest, build: 'dev' }, { ...manifest, file: 'cipher-dev.ctern' }, { ...manifest, id: 'cipher-369m-private' }, { ...manifest, build: undefined }]) {
    assert.throws(() => parseManifest(bad), /public/);
  }
  assert.equal(looksLikeDevBuild({ build: 'public', id: 'cipher-369m-sft', file: 'cipher-369m-sft.ctern' }), false);
  assert.throws(() => parseManifest({ ...manifest, file: '../x.ctern' }), /bare/);
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  const modelRes = pkg.build.extraResources.find((r: any) => r.to === 'model');
  assert.deepEqual(modelRes.filter, ['manifest.json', '*.ctern', '!*dev*', '!*private*']);
  assert.ok(pkg.build.extraResources.some((r: any) => r.to === 'bin' && r.from === 'resources/bin/${os}-${arch}'));
  assert.match(pkg.scripts.dist, /npm run native && npm run model && npm run build/);
  const out = (() => { try { execFileSync(process.execPath, [path.join(repo, 'scripts', 'fetch-model.mjs')], { cwd: repo, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CIPHER_MODEL_SRC: '/tmp/cipher-dev.ctern' }, stdio: 'pipe' }); return ''; } catch (e: any) { return String(e.stderr); } })();
  assert.match(out, /only the public Cipher build/);
});

test('no Ollama / third-party model code, settings or prompts remain in the app', () => {
  const files = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(path.join(d, e.name)) : [path.join(d, e.name)]);
  for (const f of files(path.join(repo, 'src')).filter((f) => !f.includes(`${path.sep}test${path.sep}`))) {
    assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /ollama|qwen|11434|llama3|CIPHER_MODEL\b|api\/pull|keep_alive/i, f);
  }
  assert.equal(fs.existsSync(path.join(repo, 'LICENSES', 'Qwen2.5-LICENSE.txt')), false);
  assert.doesNotMatch(fs.readFileSync(path.join(repo, 'README.md'), 'utf8'), /ollama|qwen/i);
});

test('missing model file → error with a plain message; a binary that dies at start → error, not a hang', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cserve-'));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  const states: string[] = [];
  const s1 = new CipherServer({ binary: '/bin/true', modelDir: dir, onChange: (p) => states.push(p) });
  await s1.start();
  assert.equal(s1.phase, 'error');
  assert.equal(s1.message, MODEL_FILE_MISSING_MESSAGE);
  fs.writeFileSync(path.join(dir, manifest.file), Buffer.alloc(manifest.bytes));
  const dies = path.join(dir, 'dies.sh');
  fs.writeFileSync(dies, '#!/bin/sh\nexit 3\n', { mode: 0o755 });
  const s2 = new CipherServer({ binary: dies, modelDir: dir, startTimeoutMs: 3000 });
  await s2.start();
  assert.equal(s2.phase, 'error');
  assert.equal(s2.message, START_FAILED_MESSAGE);
  assert.deepEqual(states, ['starting', 'error']);
});

test('real cipher-serve: start + health, token required, streaming chat, crash → auto-restart, graceful stop', { skip: !haveReal && 'run `npm run native && npm run model` first' }, async () => {
  const phases: string[] = [];
  const s = new CipherServer({ ...realPaths, threads: 2, onChange: (p) => phases.push(p) });
  await s.start();
  assert.equal(s.phase, 'ready', String(s.message));
  const ep = s.endpoint!;
  assert.match(ep.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal((await fetch(`${ep.baseUrl}/health`)).status, 401, 'no token → refused');
  const h = await (await fetch(`${ep.baseUrl}/health`, { headers: { Authorization: `Bearer ${ep.token}` } })).json() as any;
  assert.deepEqual([h.status, h.model, h.n_ctx], ['ok', manifest.id, 1024]);
  let streamed = '';
  const r = await streamChat({ endpoint: ep, messages: [{ role: 'system', content: manifest.systemPrompt }, { role: 'user', content: 'Hi, who are you?' }],
    maxTokens: 24, onToken: (t) => { streamed += t; } });
  assert.ok(r.content.length > 0 && r.content === streamed);
  assert.ok(r.stats && r.stats.completionTokens > 0 && r.stats.completionTokens <= 24);
  // An over-long history is trimmed server-side to fit 1,024 tokens (system kept, oldest dropped).
  const long = Array.from({ length: 40 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: `turn ${i} ` + 'tell me more about the sea '.repeat(20) }));
  const r2 = await streamChat({ endpoint: ep, messages: [{ role: 'system', content: 'You are Cipher.' }, ...long, { role: 'user', content: 'Short answer?' }], maxTokens: 8, onToken: () => {} });
  assert.ok(r2.stats!.droppedMessages > 0 && r2.stats!.promptTokens + 8 <= 1024);
  // Crash → restarted on a new port with a new process.
  const pid1 = s.pid!;
  process.kill(pid1, 'SIGKILL');
  await waitFor(() => s.phase === 'ready' && s.pid !== null && s.pid !== pid1);
  assert.ok(phases.includes('starting'));
  const pid2 = s.pid!;
  await s.stop();
  assert.equal(s.phase, 'stopped');
  await waitFor(() => !alive(pid2), 3000);
  assert.equal(s.endpoint, null);
});
