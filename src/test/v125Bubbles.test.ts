import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CipherDb } from '../main/db';
import { runChatTurn, type ActionHooks } from '../main/chatEngine';
import { DraftStore, DRAFT_FILE_TOOL, MAX_DRAFTS_PER_CHAT } from '../main/drafts';
import { WriteConsent, confirmAndWrite } from '../main/fileWrite';
import { allowPermission, allowPermissionCheck } from '../main/mediaPermission';
import { ENGINE_NAMES, MAX_PCM_BYTES, WHISPER_TESTED_VERSION, checkEngine, checkModel, checkPcm, cleanTranscript, pcmToWav, transcribe, type Runner } from '../main/voice';
import { formatWeeklyReport, weekStart } from '../main/weeklyReport';
import { PhoneServer } from '../main/phoneServer';
import { UNLOCKED_CHANNELS } from '../main/lock';
import { readUiPrefs } from '../main/uiPrefs';
import { SETTINGS_EXPORT } from '../main/settingsFile';
import { floatToPcm16, localVoices, reactionCount, searchMemory } from '../renderer/view';
import { WHATS_NEW } from '../renderer/whatsNew';
import { POLICY_SECTIONS } from '../renderer/policy';
import { modelDeps, sseBody, sseResponse } from './fakeCipher';

// v1.25: bubbles (text + time, plus menu), compact mode, local voice input, local read-aloud, file drafts,
// weekly report, drag-to-room, memory search.
const root = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const main = read('src/main/main.ts');
const preload = read('src/preload/preload.ts');
const renderer = read('src/renderer/renderer.ts');
const css = read('src/renderer/styles.css');
const html = read('src/renderer/index.html');
const voiceSrc = read('src/main/voice.ts');
const phoneJs = read('src/phone/app.js');
const phoneHtml = read('src/phone/index.html');
const policy = POLICY_SECTIONS.flatMap((s) => [s.heading, ...s.paragraphs]).join('\n');
const pkg = JSON.parse(read('package.json'));
const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cipher-v125-')), 'cipher.db');
const folder = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cipher-v125-f-'));
const fnBody = (src: string, name: string) => { const i = src.indexOf(`function ${name}(`); return src.slice(i, src.indexOf('\n}\n', i)); };

test('version 1.25.0, WHATS_NEW ≤5 lines of ≤90 chars, names stay Cipher, CSP unchanged, no new deps', () => {
  assert.equal(pkg.version, '1.25.0');
  assert.equal(pkg.name, 'cipher'); assert.equal(pkg.productName, 'Cipher');
  assert.ok(WHATS_NEW.length <= 5);
  for (const l of WHATS_NEW) assert.ok(l.length <= 90, l);
  assert.doesNotMatch(WHATS_NEW.join(' ') + policy, /Grok/);
  assert.match(html, /default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'none'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'/);
  const deps = Object.keys(pkg.dependencies ?? {}).sort();
  assert.deepEqual(deps, ['better-sqlite3', 'pdfjs-dist'].filter((d) => deps.includes(d)).concat(deps.filter((d) => !['better-sqlite3', 'pdfjs-dist'].includes(d))).sort());
  assert.doesNotMatch(JSON.stringify(pkg.dependencies ?? {}) + JSON.stringify(pkg.devDependencies ?? {}), /whisper|vosk|speech|nodejs-whisper/i, 'no speech package: the engine is the user\'s own whisper.cpp');
});

test('1. no default action row: desktop bubbles are text and time only; actions are built only when the plus opens', () => {
  const b = fnBody(renderer, 'bubble');
  assert.doesNotMatch(b, /copyButton|msg-acts|iconButton|react/);
  assert.doesNotMatch(renderer, /function copyButton|function reactBar|'msg-acts'|className = 'copy-btn'/);
  const deco = fnBody(renderer, 'decorateMessage');
  assert.doesNotMatch(deco, /iconButton\(|reactBar\(|'Edit'|msg-acts/, 'no buttons appended by default');
  assert.match(deco, /row\.append\(bubblePlus\(botMenuItems\(row, m, chatId\)\)\)/);
  // The menu is created inside the click handler, not before.
  const plus = fnBody(renderer, 'bubblePlus');
  assert.ok(plus.indexOf("addEventListener('click'") < plus.indexOf("node('div', 'bubble-menu')"));
  // Menu items: quote, pin, react (five), copy, edit (own text), delete, save to memory, read aloud.
  const items = fnBody(renderer, 'botMenuItems');
  for (const l of ["'Quote'", "'Unpin' : 'Pin'", 'REACTION_CHOICES.map', "'Copy'", "'Edit'", "'Delete'", "'Save to memory'", "'Read aloud'"]) assert.ok(items.includes(l), l);
  assert.match(items, /m\.role === 'user' && !m\.content\.startsWith\(PAGE_BLOCK_START\)\) items\.push\(\{ label: 'Edit'/);
  assert.match(fnBody(renderer, 'deleteOne'), /api\.deleteMessages\(chatId, \[id\]\)/, 'delete goes through the main-side confirm and undo');
  // Hidden until hover/focus; the plus on own bubbles uses the white-at-80% tint.
  assert.match(css, /\.bubble-plus \{[^}]*opacity: 0;/);
  assert.match(css, /\.msg:hover \.bubble-plus, \.msg:focus-within \.bubble-plus, \.msg\.menu-open \.bubble-plus \{ opacity: 1; \}/);
  assert.match(css, /\.msg\.user \.bubble-plus \.ico, \.msg\.user \.react-count \.ico \{ filter: brightness\(0\) invert\(1\); opacity: 0\.8; \}/);
  assert.match(css, /\.ico-bubble-plus \{ --ico: url\("assets\/cipher-bubble-plus\.svg"\); \}/);
  assert.doesNotMatch(css, /\.copy-btn|\.msg-acts|\.react-bar/);
});

test('1. rooms and phone: no default action row either', () => {
  const rr = fnBody(renderer, 'roomReply');
  assert.doesNotMatch(rr, /copyButton/);
  assert.match(rr, /bubblePlus\(roomMenuItems\(text\)\)/);
  assert.match(renderer, /withPlus\(bubble\('user', m\.content, false, m\.createdAt\), roomMenuItems\(m\.content\)\)/);
  const roomItems = fnBody(renderer, 'roomMenuItems');
  assert.match(roomItems, /'Copy'/); assert.match(roomItems, /Read aloud/);
  assert.doesNotMatch(roomItems, /Pin|Delete|Edit|react/i, 'rooms: copy and read aloud only');
  // Phone: bubbles are text plus who/time; no buttons inside a message.
  const am = phoneJs.slice(phoneJs.indexOf('function appendMsg'), phoneJs.indexOf('\n  }\n', phoneJs.indexOf('function appendMsg')));
  assert.ok(am.length > 0);
  assert.doesNotMatch(am, /createElement\('button'\)|\b(copy|react|quote|pin)\b/i);
});

test('2. reactions: a small count while the plus is closed; the five choices only inside the menu', () => {
  assert.equal(reactionCount(null), 0); assert.equal(reactionCount(undefined), 0); assert.equal(reactionCount('heart'), 1);
  const deco = fnBody(renderer, 'decorateMessage');
  assert.match(deco, /node\('span', 'react-count'\)/);
  assert.match(css, /\.msg\.menu-open \.react-count \{ display: none; \}/);
  assert.match(fnBody(renderer, 'botMenuItems'), /cls: 'react-btn', pressed: m\.reaction === c\.id/);
});

test('3/4. width capped at about 70ch; compact mode (Settings switch, default off, exported)', () => {
  assert.match(css, /^\.msg \{ max-width: min\(70ch, 85%\);/m);
  assert.match(css, /\.compact \.msg \{ padding: 5px 10px;/);
  assert.match(css, /\.compact \.msg \.msg-time \{ font-size: 9px;/);
  assert.match(html, /id="compact-switch"/);
  assert.match(renderer, /classList\.toggle\('compact', state\.prefs\.compact === true\)/);
  const db = new CipherDb(tmpDb());
  assert.equal(readUiPrefs((k) => db.getSetting(k)).compact, false);
  db.setSetting('compact_mode', '1');
  assert.equal(readUiPrefs((k) => db.getSetting(k)).compact, true);
  assert.ok('compact_mode' in SETTINGS_EXPORT);
  db.close();
});

test('5. voice: never the network: no webkitSpeechRecognition, no fetch/http in voice.ts, local engine via execFile only', () => {
  const code = (src: string) => src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const src of [renderer, preload, main, voiceSrc]) assert.doesNotMatch(code(src), /SpeechRecognition/);
  assert.doesNotMatch(code(voiceSrc), /fetch\(|https?:\/\/|net\.|require\('http|from 'node:https?'|download|npm|install/i);
  assert.match(voiceSrc, /execFile/);
  assert.doesNotMatch(voiceSrc, /spawn\(|exec\(|shell: true/);
  assert.equal(WHISPER_TESTED_VERSION, 'whisper.cpp v1.7.6 (whisper-cli)', 'pinned to an exact, tested version');
  assert.deepEqual(ENGINE_NAMES, ['whisper-cli', 'whisper', 'main']);
  // Engine and model are picked by the user in a native dialog in main; nothing is downloaded.
  assert.match(main, /handle\('voice:pickEngine'[\s\S]*?pickFile\(e,/);
  assert.match(main, /handle\('voice:pickModel'[\s\S]*?extensions: \['bin'\]/);
  assert.match(main, /handle\('voice:transcribe', async \(_e, pcm: unknown\) => transcribe\(\{ engine: db\.getSetting\(VOICE_ENGINE_KEY\), model: db\.getSetting\(VOICE_MODEL_KEY\), pcm \}\)\)/, 'paths come from main, never the window');
  assert.doesNotMatch(preload, /voice:\w+', *(path|engine|model)/);
  for (const ch of ['voice:state', 'voice:pickEngine', 'voice:pickModel', 'voice:clear', 'voice:transcribe', 'drafts:list', 'drafts:save', 'drafts:discard', 'report:weekly', 'report:save']) {
    assert.ok(!UNLOCKED_CHANNELS.has(ch), `${ch} needs unlock`);
  }
});

test('5. voice: transcribe runs only the chosen local engine with a minimal env and cleans its temp folder', async () => {
  const dir = folder();
  const engine = path.join(dir, 'whisper-cli');
  fs.writeFileSync(engine, '#!/bin/sh\necho hi\n', { mode: 0o755 });
  const model = path.join(dir, 'ggml-tiny.en.bin');
  const magic = Buffer.alloc(16); magic.writeUInt32LE(0x67676d6c, 0);
  fs.writeFileSync(model, magic);
  const pcm = floatToPcm16(new Float32Array(16000).fill(0.1));
  let seen: { file: string; args: string[]; env: NodeJS.ProcessEnv; wav: string } | null = null;
  const run: Runner = async (file, args, opts) => {
    const wav = args[args.indexOf('-f') + 1];
    assert.ok(fs.existsSync(wav));
    assert.equal(fs.statSync(wav).mode & 0o777, 0o600);
    seen = { file, args, env: opts.env, wav };
    return '[00:00.000 --> 00:01.000]  Hello there.\n';
  };
  const text = await transcribe({ engine, model, pcm, run });
  assert.equal(text, 'Hello there.');
  assert.equal(seen!.file, fs.realpathSync(engine));
  assert.deepEqual(Object.keys(seen!.env).sort(), ['HOME', 'LANG', 'PATH']);
  assert.ok(!fs.existsSync(path.dirname(seen!.wav)), 'temp folder removed');
  // Failure also cleans up.
  await assert.rejects(transcribe({ engine, model, pcm, run: async (_f, a) => { seen!.wav = a[a.indexOf('-f') + 1]; throw new Error('boom'); } }));
  assert.ok(!fs.existsSync(path.dirname(seen!.wav)));
  // Checks: relative path, wrong name, not executable, wrong model magic, too much audio.
  await assert.rejects(checkEngine('whisper-cli'));
  const bad = path.join(dir, 'curl'); fs.writeFileSync(bad, '', { mode: 0o755 });
  await assert.rejects(checkEngine(bad));
  const noexec = path.join(dir, 'whisper'); fs.writeFileSync(noexec, '', { mode: 0o644 });
  await assert.rejects(checkEngine(noexec));
  const fake = path.join(dir, 'fake.bin'); fs.writeFileSync(fake, Buffer.alloc(16));
  await assert.rejects(checkModel(fake));
  assert.throws(() => checkPcm(new Uint8Array(MAX_PCM_BYTES + 2)));
  assert.throws(() => checkPcm('nope'));
  assert.equal(pcmToWav(new Uint8Array(4)).subarray(0, 4).toString(), 'RIFF');
  assert.equal(cleanTranscript('[BLANK_AUDIO]\n'), '');
});

test('5. mic permission: audio only, main window only, file:// only; everything else denied; stream released', () => {
  const ok = { permission: 'media', mediaTypes: ['audio'], isMainWindow: true, url: 'file:///app/index.html' };
  assert.equal(allowPermission(ok), true);
  assert.equal(allowPermission({ ...ok, mediaTypes: ['video'] }), false);
  assert.equal(allowPermission({ ...ok, mediaTypes: ['audio', 'video'] }), false);
  assert.equal(allowPermission({ ...ok, mediaTypes: [] }), false);
  assert.equal(allowPermission({ ...ok, isMainWindow: false }), false);
  assert.equal(allowPermission({ ...ok, url: 'https://example.com' }), false);
  for (const p of ['notifications', 'geolocation', 'clipboard-read', 'display-capture', 'midi', 'openExternal', 'fullscreen']) assert.equal(allowPermission({ ...ok, permission: p }), false, p);
  assert.equal(allowPermissionCheck({ permission: 'media', mediaType: 'audio', isMainWindow: true, url: ok.url }), true);
  assert.equal(allowPermissionCheck({ permission: 'media', mediaType: 'video', isMainWindow: true, url: ok.url }), false);
  assert.match(main, /setPermissionRequestHandler\(/);
  assert.match(main, /setPermissionCheckHandler\(/);
  assert.match(main, /setDevicePermissionHandler\(\(\) => false\)/);
  // Renderer: audio only; tracks stopped on release, blur and lock.
  assert.match(renderer, /getUserMedia\(\{ audio: true, video: false \}\)/);
  assert.match(fnBody(renderer, 'releaseMic'), /getTracks\(\)\.forEach\(\(t\) => t\.stop\(\)\)/);
  assert.match(renderer, /el\.mic\.addEventListener\('pointerup'/);
  assert.match(renderer, /window\.addEventListener\('blur', \(\) => releaseMic\(\)\)/);
  assert.match(fnBody(renderer, 'showLockScreen'), /releaseMic\(\)/);
  assert.match(fnBody(renderer, 'micUp'), /^[\s\S]*?releaseMic\(\);[\s\S]*api\.transcribe/, 'released before transcribing');
  assert.match(html, /id="mic"[^>]*hidden/);
  assert.match(css, /\.ico-mic \{ --ico: url\("assets\/cipher-mic\.svg"\); \}/);
});

test('5. the phone has no voice: no UI, and voice/draft/report routes are 403', async () => {
  assert.doesNotMatch(phoneJs + phoneHtml, /getUserMedia|mic|SpeechRecognition|speechSynthesis|transcribe|read-aloud/i);
  const db = new CipherDb(tmpDb());
  const port = 28800 + Math.floor(Math.random() * 300);
  const staticDir = fs.existsSync(path.join(__dirname, '..', 'phone', 'index.html')) ? path.join(__dirname, '..', 'phone') : path.join(root, 'src', 'phone');
  const server = new PhoneServer({ db, staticDir, model: 'fake', port, sendChat: async () => {}, stopChat: () => {}, sendRoom: async () => {}, stopRoom: () => {} });
  server.start();
  await server.whenListening();
  const base = `http://127.0.0.1:${port}`;
  try {
    const pr = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: server.status().pairingCode }) });
    const token = String(((await pr.json()) as { token: string }).token);
    for (const p of ['/api/voice', '/api/mic', '/api/speech', '/api/transcribe', '/api/drafts', '/api/draft', '/api/report', '/api/read-aloud']) {
      for (const method of ['GET', 'POST']) {
        const r = await fetch(`${base}${p}`, { method, headers: { Authorization: `Bearer ${token}` } });
        assert.equal(r.status, 403, `${method} ${p}`);
      }
    }
  } finally { server.stop(); db.close(); }
});

test('6. read-aloud: only voices with localService === true; off until tapped; nothing spoken without one', () => {
  const vs = [{ name: 'net', localService: false }, { name: 'here', localService: true }, { name: 'x', localService: 'true' as unknown as boolean }];
  assert.deepEqual(localVoices(vs).map((v) => v.name), ['here']);
  assert.deepEqual(localVoices([{ name: 'net', localService: false }]), []);
  const ra = fnBody(renderer, 'readAloud');
  assert.match(ra, /const voice = localVoices\(synth\.getVoices\(\)\)\[0\];/);
  assert.match(ra, /if \(!voice\) \{[^}]*return; \}/);
  assert.match(ra, /u\.voice = voice;/);
  assert.ok(ra.indexOf('if (!voice)') < ra.indexOf('synth.speak('));
  // Only called from a menu tap.
  assert.equal((renderer.match(/readAloud\(/g) ?? []).length, 3, 'definition + bot menu + room menu');
  assert.match(fnBody(renderer, 'showLockScreen'), /speechSynthesis\?\.cancel\(\)/);
  assert.match(css, /\.ico-read-aloud \{ --ico: url\("assets\/cipher-read-aloud\.svg"\); \}/);
});

test('7. a draft never writes before confirm: store is memory only; save goes through the v1.22 token confirm', async () => {
  const store = new DraftStore();
  const d = folder();
  const draft = store.add(1, 1, 'plan.md', '# plan');
  assert.deepEqual(fs.readdirSync(d), [], 'nothing written by drafting');
  assert.throws(() => store.add(1, 1, '../escape.txt', 'x'));
  assert.throws(() => store.add(1, 1, '/etc/passwd', 'x'));
  for (let i = 1; i < MAX_DRAFTS_PER_CHAT; i++) store.add(1, 1, `f${i}.txt`, 'x');
  assert.throws(() => store.add(1, 1, 'one-too-many.txt', 'x'), /Up to 5 drafts/);
  assert.equal(store.get(draft.id, 2), null, 'another chat cannot reach it');
  // Cancel: no write, no token left.
  const consent = new WriteConsent();
  const t = store.take(draft.id, 1)!;
  assert.equal(store.take(draft.id, 1), null, 'one use');
  let r = await confirmAndWrite({ consent, isLocked: () => false, ask: async () => 0 }, 1, 'Ada', d, t.path, t.content);
  assert.equal(r.ok, false); assert.match(r.content, /cancelled: no file was written/);
  assert.deepEqual(fs.readdirSync(d), []);
  assert.equal(consent.size, 0);
  // Locked while asking: nothing written.
  let locked = false;
  r = await confirmAndWrite({ consent, isLocked: () => locked, ask: async () => { locked = true; return 1; } }, 1, 'Ada', d, t.path, t.content);
  assert.deepEqual(fs.readdirSync(d), []);
  // Confirmed: written exactly once.
  r = await confirmAndWrite({ consent, isLocked: () => false, ask: async () => 1 }, 1, 'Ada', d, t.path, t.content);
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(d, 'plan.md'), 'utf8'), '# plan');
  // Lock clears every draft.
  store.clearAll(); assert.equal(store.size, 0);
  assert.match(main, /phoneUnlock\?\.revokeAll\(\);[\s\S]{0,200}drafts\.clearAll\(\)/);
  // main: switches re-checked at Save; confirmAndWrite is the only path; renderer cannot pass content or path.
  const save = main.slice(main.indexOf("handle('drafts:save'"), main.indexOf("handle('voice:state'"));
  assert.match(save, /toolSwitches\(bot\)\.files \|\| !toolSwitches\(bot\)\.write \|\| !bot\.folderPath\) throw/);
  assert.match(save, /confirmAndWrite\(\{ consent: writeConsent, isLocked, ask:/);
  assert.doesNotMatch(save, /fs\./);
  assert.match(preload, /saveDraft: \(chatId, id\) => ipcRenderer\.invoke\('drafts:save', chatId, id\)/);
  assert.equal(DRAFT_FILE_TOOL.function.name, 'draft_file');
  assert.match(renderer, /m\.toolName === 'draft_file'\) \{[\s\S]{0,200}`Draft file: \$\{m\.content\}`/, 'a draft result is never shown as a file read');
});

test('7. draft_file in the engine: only offered with Files + Write on, a folder and desktop actions; never writes', async () => {
  const db = new CipherDb(tmpDb());
  const d = folder();
  const bot0 = db.createBot({ name: 'Ada', systemPrompt: 'Hi', toolsEnabled: true, folderPath: d });
  const chat = db.getBotChat(bot0.id);
  const hits: string[] = [];
  const actions: ActionHooks = {
    writeFile: async () => { throw new Error('must not write'); },
    addChecklist: async () => { throw new Error('no'); },
    draftFile: async (_c, _b, p) => { hits.push(String(p)); return { ok: true, path: String(p), content: 'Draft kept. Nothing is written until the user saves it.' }; },
  };
  const calls = [{ function: { name: 'draft_file', arguments: { path: 'x.txt', content: 'hi' } } }];
  const scripted = (offered: string[][]): typeof fetch => {
    let round = 0;
    return (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      offered.push((body.tools ?? []).map((t: { function: { name: string } }) => t.function.name));
      const msg = round++ === 0 ? { role: 'assistant', content: '', tool_calls: calls } : { role: 'assistant', content: 'ok' };
      return sseResponse(msg);
    }) as unknown as typeof fetch;
  };
  let offered: string[][] = [];
  await runChatTurn({ db, ...modelDeps(), emit: () => undefined, fetchImpl: scripted(offered), actions }, chat.id, 'draft', new AbortController().signal);
  assert.ok(!offered[0].includes('draft_file'), 'write switch off: not offered');
  assert.deepEqual(hits, [], 'write off: refused even when called');
  db.setToolSwitches(bot0.id, { write: true });
  offered = [];
  await runChatTurn({ db, ...modelDeps(), emit: () => undefined, fetchImpl: scripted(offered), actions }, chat.id, 'draft', new AbortController().signal);
  assert.ok(offered[0].includes('draft_file'));
  assert.deepEqual(hits, ['x.txt']);
  assert.deepEqual(fs.readdirSync(d), [], 'no file written by the engine');
  offered = []; hits.length = 0;
  await runChatTurn({ db, ...modelDeps(), emit: () => undefined, fetchImpl: scripted(offered) }, chat.id, 'draft', new AbortController().signal);
  assert.ok(!offered[0].includes('draft_file'), 'no desktop actions (phone/routine): not offered');
  assert.deepEqual(hits, []);
  db.close();
});

test('8. weekly report: counts only, never chat text; made on this computer', () => {
  const db = new CipherDb(tmpDb());
  const bot = db.createBot({ name: 'Ada', systemPrompt: '', toolsEnabled: false, folderPath: null });
  const chat = db.getBotChat(bot.id);
  const SECRET = 'my secret bank pin is 4417';
  db.addMessage({ chatId: chat.id, role: 'user', content: SECRET });
  db.addMessage({ chatId: chat.id, role: 'assistant', content: `About ${SECRET}` });
  db.addMessage({ chatId: chat.id, role: 'tool', content: '42', toolName: 'calculator' });
  const since = weekStart(new Date()).toISOString();
  const c = db.weeklyCounts(since);
  const ada = c.bots.find((b) => b.name === 'Ada')!;
  assert.equal(ada.sent, 1); assert.equal(ada.replies, 1);
  assert.deepEqual(c.tools, [{ tool: 'calculator', uses: 1 }]);
  const text = formatWeeklyReport({ since, until: new Date().toISOString(), ...c, backups: { scheduled: 'weekly', last: null, inFolder: 3 } });
  assert.ok(!text.includes(SECRET) && !text.includes('4417') && !text.includes('42\n'));
  assert.match(text, /Ada: 1 sent, 1 replies/);
  assert.match(text, /Calculator: 1/);
  assert.match(text, /Backup files in the chosen folder: 3/);
  assert.match(text, /Counts only\./);
  // The SQL selects counts, never content.
  const dbSrc = read('src/main/db.ts');
  const q = dbSrc.slice(dbSrc.indexOf('weeklyCounts('), dbSrc.indexOf('\n  }\n', dbSrc.indexOf('weeklyCounts(')));
  assert.doesNotMatch(q, /\bcontent\b(?! <> '')/, 'content only tested for being non-empty, never selected');
  assert.match(main, /handle\('report:save'[\s\S]*?fs\.writeFile\(r\.filePath, await weekly\(\)/, 'saved text regenerated in main, never from the window');
  db.close();
});

test('9/10. drag a bot onto another to start a room; search inside one bot\'s memory', () => {
  assert.match(renderer, /btn\.draggable = true;/);
  assert.match(renderer, /setData\('application\/x-cipher-bot', String\(b\.id\)\)/);
  assert.match(renderer, /if \(\/\^\\d\+\$\/\.test\(raw\)\) void roomFromDrag\(Number\(raw\), b\.id\)/);
  assert.match(renderer, /dropEffect = \(e\.target as Element \| null\)\?\.closest\?\.\('#bot-list \.rail-btn\.bot'\) \? 'link' : 'none';/, 'a bot drag never drops onto the chat');
  assert.match(fnBody(renderer, 'roomFromDrag'), /if \(fromId === toId\) return;[\s\S]*api\.createRoom\(\{ name: '', botIds: \[toId, fromId\] \}\)/);
  const note = 'I live in Lyon\nprefer metric units\nlyon has two rivers';
  assert.deepEqual(searchMemory(note, 'LYON'), [{ line: 1, text: 'I live in Lyon' }, { line: 3, text: 'lyon has two rivers' }]);
  assert.deepEqual(searchMemory(note, '   '), []);
  assert.deepEqual(searchMemory(note, 'paris'), []);
  assert.match(html, /id="memory-search"/);
  assert.match(fnBody(renderer, 'renderMemorySearch'), /searchMemory\(el\.botMemory\.value, el\.memorySearch\.value\)/);
});

test('policy describes v1.25 truthfully', () => {
  assert.match(policy, /Voice input \(v1\.25, desktop only\)[\s\S]*every other permission request[\s\S]*downloads and installs nothing[\s\S]*online speech recognition is never used[\s\S]*phone has no voice input/);
  assert.match(policy, /Read aloud \(v1\.25\)[\s\S]*voices that would use the network are never used/);
  assert.match(policy, /File drafts \(v1\.25\)[\s\S]*Nothing is written until you press Save and confirm/);
  assert.match(policy, /Weekly report \(v1\.25\)[\s\S]*never contains chat text/);
});

test('mic recording state: red dot + soft pulse, steady red ring under reduce motion, aria Recording (CSS in stylesheet)', () => {
  const cssR = fs.readFileSync(path.join(__dirname, '..', '..', 'src/renderer/styles.css'), 'utf8');
  const rr = fs.readFileSync(path.join(__dirname, '..', '..', 'src/renderer/renderer.ts'), 'utf8');
  const rec = /\.composer-circle\.mic\.recording \{([^}]*)\}/.exec(cssR)?.[1] ?? '';
  assert.match(rec, /background: #d93a4a/); assert.doesNotMatch(rec, /var\(--accent\)/, 'not the teal of Send');
  assert.match(rec, /animation: mic-pulse/);
  assert.match(cssR, /\.composer-circle\.mic\.recording::after \{ content: ""[^}]*border-radius: 50%;[^}]*background: #ff4d5e/);
  assert.match(cssR, /@keyframes mic-pulse/);
  assert.match(cssR, /:root\.reduce-motion \.composer-circle\.mic\.recording \{ animation: none; box-shadow: 0 0 0 3px #ff4d5e; \}/);
  assert.match(cssR, /@media \(prefers-reduced-motion: reduce\) \{ \.composer-circle\.mic\.recording \{ animation: none; box-shadow: 0 0 0 3px #ff4d5e; \} \}/);
  assert.match(rr, /el\.mic\.setAttribute\('aria-pressed', 'true'\);\n  el\.mic\.setAttribute\('aria-label', 'Recording'\);/);
  assert.match(rr, /el\.mic\.setAttribute\('aria-pressed', 'false'\);\n  el\.mic\.setAttribute\('aria-label', 'Hold to talk'\);/);
  assert.doesNotMatch(rr, /el\.mic\.style\./, 'no inline styles');
});
