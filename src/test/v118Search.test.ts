import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { assertLinkOpenAllowed, assertSearchAllowed, isSearchUrl, SEARCH_URL } from '../main/networkGuard';
import { NOT_CONFIRMED_RESULT, OFF_RESULT, SearchOffError, formatResultsForModel, normalizeQuery, parseResults, realResultUrl, webSearch } from '../main/webSearch';
import { CONSENT_TTL_MS, SearchConsent } from '../main/searchConsent';
import { runSearchCall, type EngineDeps, type SearchHooks } from '../main/chatEngine';
import { htmlToText, isHtmlPath } from '../main/htmlText';
import { attachFromPath } from '../main/attachFile';
import { CipherDb, SCHEMA_VERSION } from '../main/db';
import { UNLOCKED_CHANNELS } from '../main/lock';

// v1.18: web search (Online on + Search pressed), kill switch, result links, dropped web pages, policy.
const root = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const main = read('src/main/main.ts');
const renderer = read('src/renderer/renderer.ts');
const html = read('src/renderer/index.html');
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cipher-v118-')));

const DDG_HTML = `
<div class="result result--ad"><a class="result__a" href="https://duckduckgo.com/y.js?ad_provider=x">Ad</a></div>
<div class="result"><h2><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fx%3D1&amp;rut=abc">Example &amp; <b>A</b></a></h2>
<a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">First <b>snippet</b> &#39;here&#39;</a></div>
<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=javascript%3Aalert(1)">Bad</a></div>
<div class="result"><a class="result__a" href="https://example.org/b">B title</a><a class="result__snippet">B snip</a></div>
${Array.from({ length: 8 }, (_, i) => `<a class="result__a" href="https://e${i}.test/">T${i}</a>`).join('')}`;

type Call = { url: string; init: RequestInit };
function fakeFetch(calls: Call[], answer: () => Response = () => new Response(DDG_HTML, { status: 200 })): typeof fetch {
  return (async (url: string, init: RequestInit) => { calls.push({ url, init }); return answer(); }) as unknown as typeof fetch;
}

test('1. guard: only https://html.duckduckgo.com/html/; refused while Online is off; links are http(s) only and need Online', () => {
  assert.equal(SEARCH_URL, 'https://html.duckduckgo.com/html/');
  assert.ok(isSearchUrl(SEARCH_URL));
  for (const u of ['http://html.duckduckgo.com/html/', 'https://duckduckgo.com/html/', 'https://html.duckduckgo.com.evil.test/html/',
    'https://html.duckduckgo.com:8443/html/', 'https://html.duckduckgo.com/lite/', 'https://u:p@html.duckduckgo.com/html/', 'https://example.com/']) {
    assert.equal(isSearchUrl(u), false, u);
    assert.throws(() => assertSearchAllowed(true, u), /Only web search/);
  }
  assert.throws(() => assertSearchAllowed(false, SEARCH_URL), /Online is off/);
  assert.doesNotThrow(() => assertSearchAllowed(true, SEARCH_URL));
  assert.doesNotThrow(() => assertLinkOpenAllowed(true, 'https://example.com/'));
  assert.throws(() => assertLinkOpenAllowed(false, 'https://example.com/'), /Online is off/);
  for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'mailto:a@b.c', 'ftp://x/', 'not a url']) assert.throws(() => assertLinkOpenAllowed(true, u));
});

test('1. the renderer never connects: CSP connect-src none; no fetch/XHR/WebSocket in renderer code; search requests only in webSearch.ts', () => {
  assert.match(html, /connect-src 'none'/);
  assert.doesNotMatch(renderer, /\bfetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/);
  const mainDir = path.join(root, 'src/main');
  for (const f of fs.readdirSync(mainDir)) {
    const src = fs.readFileSync(path.join(mainDir, f), 'utf8');
    if (/duckduckgo/i.test(src)) assert.ok(['webSearch.ts', 'networkGuard.ts'].includes(f), f);
    if (/\bfetch\(/.test(src)) assert.ok(['webSearch.ts', 'ollama.ts'].includes(f), `${f} calls fetch`);
  }
});

test('1. webSearch: POSTs only the query to the one endpoint, follows no redirect (any 3xx refused), no cookies', async () => {
  const calls: Call[] = [];
  const consent = new SearchConsent();
  const tok = consent.issue(1, 'cats');
  let sent = 0;
  const res = await webSearch('  cats ', { isOnline: () => true, consumeConsent: (q) => consent.consume(tok, 1, q), onSend: () => sent++, fetchImpl: fakeFetch(calls) });
  assert.equal(calls.length, 1);
  assert.equal(sent, 1);
  assert.equal(calls[0].url, SEARCH_URL);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.body, 'q=cats');
  assert.equal(res.length, 5);
  assert.deepEqual(res[0], { title: 'Example & A', url: 'https://example.com/a?x=1', snippet: "First snippet 'here'" });
  assert.equal(res[1].url, 'https://example.org/b');
  assert.ok(res.every((r) => /^https?:/.test(r.url) && !/duckduckgo/.test(r.url)));
  // A redirect (to anywhere) is refused.
  for (const answer of [() => new Response(null, { status: 302, headers: { location: 'https://evil.test/' } }),
    () => Object.assign(new Response(null, { status: 200 }), {}) as Response]) {
    const t = consent.issue(1, 'dogs');
    const isRedirect = answer().status === 302;
    const p = webSearch('dogs', { isOnline: () => true, consumeConsent: (q) => consent.consume(t, 1, q), fetchImpl: fakeFetch([], answer) });
    if (isRedirect) await assert.rejects(p, /redirect; refused/); else await p;
  }
  const opaque = { type: 'opaqueredirect', status: 0, ok: false } as unknown as Response;
  const t2 = consent.issue(1, 'x');
  await assert.rejects(webSearch('x', { isOnline: () => true, consumeConsent: (q) => consent.consume(t2, 1, q), fetchImpl: fakeFetch([], () => opaque) }), /redirect; refused/);
  // A bot-check page (202, or 200 with the anomaly form) is an error, not "no results".
  const t3 = consent.issue(1, 'y');
  await assert.rejects(webSearch('y', { isOnline: () => true, consumeConsent: (q) => consent.consume(t3, 1, q), fetchImpl: fakeFetch([], () => new Response('<form id="challenge-form">anomaly</form>', { status: 202 })) }), /DuckDuckGo answered 202/);
  const t4 = consent.issue(1, 'y');
  await assert.rejects(webSearch('y', { isOnline: () => true, consumeConsent: (q) => consent.consume(t4, 1, q), fetchImpl: fakeFetch([], () => new Response('<div class="anomaly-modal">x</div>', { status: 200 })) }), /not a robot/);
  assert.equal(realResultUrl('//duckduckgo.com/l/?uddg=javascript%3Aalert(1)'), null);
  assert.equal(realResultUrl('https://duckduckgo.com/y.js?ad=1'), null);
});

test('2. one-time token: issued for a chat and exact query, single use, expires; without it nothing is sent', async () => {
  let now = 1000;
  const c = new SearchConsent(() => now);
  const t = c.issue(7, 'weather paris');
  assert.match(t, /^[0-9a-f]{48}$/);
  assert.equal(c.consume(t, 7, 'weather paris!'), false, 'other query');
  const t1 = c.issue(7, 'weather paris');
  assert.equal(c.consume(t1, 8, 'weather paris'), false, 'other chat');
  const t3 = c.issue(7, 'weather paris');
  assert.equal(c.consume(t3, 7, 'weather paris'), true);
  assert.equal(c.consume(t3, 7, 'weather paris'), false, 'single use');
  assert.equal(c.consume('made-up', 7, 'weather paris'), false);
  assert.equal(c.consume(undefined, 7, 'weather paris'), false);
  const t4 = c.issue(7, 'q');
  now += CONSENT_TTL_MS + 1;
  assert.equal(c.consume(t4, 7, 'q'), false, 'expired');
  c.issue(1, 'a'); c.revokeAll(); assert.equal(c.size, 0);
  // The request itself refuses without a valid token, and while Online is off; fetch is never called.
  const calls: Call[] = [];
  await assert.rejects(webSearch('q', { isOnline: () => true, consumeConsent: () => false, fetchImpl: fakeFetch(calls) }), /not confirmed/);
  await assert.rejects(webSearch('q', { isOnline: () => false, consumeConsent: () => true, fetchImpl: fakeFetch(calls) }), SearchOffError);
  assert.equal(calls.length, 0);
  assert.throws(() => normalizeQuery(''), /empty/);
  assert.throws(() => normalizeQuery('x'.repeat(301)), /longer/);
  assert.throws(() => normalizeQuery({}), /text/);
});

test('2. main issues tokens only from its own pending ask, only on Search, only while Online and unlocked; gated while locked', () => {
  assert.match(main, /handle\('search:answer', \(_e, id: unknown, ok: unknown\) => answerSearchAsk\(id, ok\)\);/);
  const answer = /function answerSearchAsk[\s\S]*?\n\}/.exec(main)![0];
  assert.match(answer, /pendingSearchAsks\.get\(id\)/);
  assert.match(answer, /ok === true && isOnline\(\) && !isLocked\(\) \? searchConsent\.issue\(ask\.chatId, ask\.query\) : null/);
  assert.doesNotMatch(answer, /query\s*:\s*unknown|_e, id: unknown, ok: unknown, /, 'the renderer cannot supply the query');
  for (const ch of ['search:answer', 'search:pending', 'search:last', 'link:open']) assert.equal(UNLOCKED_CHANNELS.has(ch), false, ch);
  assert.match(main, /consumeConsent: \(q\) => searchConsent\.consume\(token, chatId, q\)/);
  assert.match(main, /run: async[\s\S]*?if \(isLocked\(\)\) throw/);
  assert.match(main, /confirm: [\s\S]*?if \(!isOnline\(\) \|\| isLocked\(\) \|\| signal\.aborted\) \{ resolve\(null\); return; \}/);
  // v1.19: phone turns get search (confirm card on the phone too); routines never; rooms have no tools at all.
  assert.match(main, /forceToolsOff: toolsOff, search: searchHooks(, userExtras)?(, sharedFolder)? \}/);
  assert.match(main, /runChatTurn\(\{ db, model: currentModel\(\), emit, forceToolsOff: true, fromRoutine: true \}/);
  assert.doesNotMatch(read('src/main/roomEngine.ts'), /web_search|search/i);
  assert.doesNotMatch(read('src/main/phoneServer.ts'), /web_search|searchHooks|webSearch\(/);
});

function hooks(over: Partial<SearchHooks> & { log?: string[] } = {}): SearchHooks {
  const log = over.log ?? [];
  return {
    isOnline: over.isOnline ?? (() => true),
    confirm: over.confirm ?? (async (_c, q) => { log.push(`confirm:${q}`); return 'tok'; }),
    run: over.run ?? (async (_c, q, t) => { log.push(`run:${q}:${t}`); return [{ title: 'T', url: 'https://x.test/', snippet: 's' }]; }),
  };
}
const call = (query: unknown) => ({ function: { name: 'web_search', arguments: { query } } });
const deps = (search?: SearchHooks, fromRoutine = false) => ({ db: {} as never, model: 'm', emit: () => undefined, fromRoutine, search }) as EngineDeps;

test('2. engine: asks first; Cancel / no answer → "User did not confirm the search" and nothing runs; no hooks → refused', async () => {
  const sig = new AbortController().signal;
  const log: string[] = [];
  const ok = await runSearchCall(deps(hooks({ log })), 1, call('cats'), sig);
  assert.deepEqual(log, ['confirm:cats', 'run:cats:tok']);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.search, { query: 'cats', results: [{ title: 'T', url: 'https://x.test/', snippet: 's' }] });
  assert.equal(ok.content, formatResultsForModel('cats', ok.search!.results));
  const log2: string[] = [];
  const no = await runSearchCall(deps(hooks({ log: log2, confirm: async () => null })), 1, call('cats'), sig);
  assert.equal(no.content, NOT_CONFIRMED_RESULT);
  assert.match(no.content, /^User did not confirm the search/);
  assert.deepEqual(log2, []);
  for (const d of [deps(undefined), deps(hooks(), true)]) {
    const r = await runSearchCall(d, 1, call('cats'), sig);
    assert.equal(r.ok, false);
    assert.match(r.content, /not available here/);
  }
  const off = await runSearchCall(deps(hooks({ isOnline: () => false, confirm: async () => { throw new Error('must not ask'); } })), 1, call('x'), sig);
  assert.equal(off.content, OFF_RESULT);
  const bad = await runSearchCall(deps(hooks()), 1, call(42), sig);
  assert.match(bad.content, /^Error: The search query must be text/);
});

test('3. kill switch: Online off aborts an in-flight search, drops its answer, and closes every confirm card', async () => {
  let online = true;
  const ac = new AbortController();
  let fetchSignal: AbortSignal | undefined;
  const slow = (async (_u: string, init: RequestInit) => {
    fetchSignal = init.signal ?? undefined;
    return new Promise<Response>((_res, rej) => init.signal!.addEventListener('abort', () => rej(new Error('aborted'))));
  }) as unknown as typeof fetch;
  const p = webSearch('q', { isOnline: () => online, consumeConsent: () => true, fetchImpl: slow, signal: ac.signal });
  await new Promise((r) => setImmediate(r));
  online = false; ac.abort(); // what killSearch() does
  await assert.rejects(p);
  assert.equal(fetchSignal?.aborted, true);
  // An answer that arrives after Online went off is dropped.
  let on2 = true;
  const late = (async () => { on2 = false; return new Response(DDG_HTML); }) as unknown as typeof fetch;
  await assert.rejects(webSearch('q', { isOnline: () => on2, consumeConsent: () => true, fetchImpl: late }), SearchOffError);
  // Wiring in main: Online off and lock both call killSearch, which aborts, closes cards (search:closed) and revokes tokens.
  const kill = /function killSearch\(\): void \{[\s\S]*?\n\}/.exec(main)![0];
  assert.match(kill, /for \(const c of activeSearches\) c\.abort\(\);/);
  assert.match(kill, /settleSearchAsk\(id, null\)/);
  assert.match(kill, /searchConsent\.revokeAll\(\);/);
  assert.match(main, /function settleSearchAsk[\s\S]*?webContents\.send\('search:closed', \{ id \}\)/);
  assert.match(main, /if \(!value\) killSearch\(\);/);
  assert.match(main, /appLock\.lock\(\);\s*killSearch\(\);/);
  assert.match(renderer, /api\.onSearchClosed\(onSearchClosed\)/);
  // The tool itself leaves the reply when Online goes off (re-checked every round).
  const engine = read('src/main/chatEngine.ts');
  assert.match(engine, /case 'web_search': return t\.search && !deps\.fromRoutine && !!deps\.search && deps\.search\.isOnline\(\);/);
  assert.match(engine, /const searchOn = \(\): boolean => allowed\('web_search'\);/);
  assert.match(engine, /tools: offeredTools\(\),/);
  // Online-off result mid-search.
  let on3 = true;
  const r = await runSearchCall(deps(hooks({ run: async () => { on3 = false; throw new Error('aborted'); }, isOnline: () => on3 })), 1, call('q'), new AbortController().signal);
  assert.equal(r.content, OFF_RESULT);
});

test('4. result links: shell.openExternal only from link:open, on click, http(s), Online on, and only stored result links', () => {
  const open = /handle\('link:open'[\s\S]*?\n {2}\}\);/.exec(main)![0];
  assert.match(open, /assertLinkOpenAllowed\(isOnline\(\), url\);\s*if \(!db\.isStoredResultUrl\(url\)\) throw[\s\S]*?await shell\.openExternal\(url\);/);
  assert.match(renderer, /link\.addEventListener\('click', \(\) => void api\.openLink\(r\.url\)/);
  assert.doesNotMatch(renderer, /<a\b|createElement\('a'\)|window\.open/);
  // Results are text nodes (textContent), never HTML.
  assert.doesNotMatch(/function searchResultRow[\s\S]*?\n\}/.exec(renderer)![0], /innerHTML/);
});

test('4. a dropped .html page is attached as text through attachFromPath: scripts, styles and remote resources stripped', async () => {
  const folder = path.join(base, 'pages');
  fs.mkdirSync(folder);
  const page = '<!doctype html><html><head><title>T</title><script src="https://evil.test/x.js"></script><link rel="stylesheet" href="https://evil.test/s.css"></head>' +
    '<body><h1>Hello &amp; welcome</h1><script>alert("x")</script><style>p{color:red}</style><p>Para <a href="https://evil.test/">link text</a></p>' +
    '<img src="https://evil.test/i.png" alt="pic"><ul><li>one</li><li>two</li></ul><!-- secret comment --></body></html>';
  fs.writeFileSync(path.join(folder, 'page.html'), page);
  fs.writeFileSync(path.join(folder, 'old.HTM'), '<p>x</p>');
  assert.ok(isHtmlPath('page.html') && isHtmlPath('old.HTM') && !isHtmlPath('a.txt'));
  const r = await attachFromPath({ folderPath: folder }, path.join(folder, 'page.html'));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.match(r.block, /Hello & welcome/);
  assert.match(r.block, /Para link text/);
  assert.match(r.block, /• one\n• two/);
  assert.doesNotMatch(r.block, /<script|alert|evil\.test|color:red|secret comment|<img|<a /);
  assert.equal(htmlToText('<p>a</p><p>b</p>'), 'a\nb');
  // Same folder rules: a page outside the folder is refused.
  fs.writeFileSync(path.join(base, 'out.html'), '<p>TOP SECRET</p>');
  const out = await attachFromPath({ folderPath: folder }, path.join(base, 'out.html'));
  assert.equal(out.ok, false);
  assert.doesNotMatch(JSON.stringify(out), /TOP SECRET/);
  assert.match(main, /handle\('attach:dropped'[\s\S]*?return attachFromPath\(bot, filePath\);/);
});

test('results persist in the chat (schema v8, idempotent migration); only stored result links count as openable', () => {
  const file = path.join(base, 'c.db');
  let db = new CipherDb(file);
  assert.equal(SCHEMA_VERSION >= 8, true);
  const bot = db.createBot({ name: 'Ada', systemPrompt: '', toolsEnabled: false, folderPath: null });
  const chat = db.createChat(bot.id);
  const search = { query: 'cats', results: [{ title: 'Cats "x"', url: 'https://cats.test/a?b=1', snippet: 's' }] };
  db.addMessage({ chatId: chat.id, role: 'tool', content: 'r', toolName: 'web_search', search });
  db.addMessage({ chatId: chat.id, role: 'user', content: 'u', search });
  db.close();
  db = new CipherDb(file);
  const msgs = db.listMessages(chat.id);
  assert.deepEqual(msgs[0].search, search);
  assert.equal(msgs[1].search, null, 'only tool messages carry results');
  assert.equal(db.isStoredResultUrl('https://cats.test/a?b=1'), true);
  assert.equal(db.isStoredResultUrl('https://cats.test/'), false);
  db.close();
  const raw = new Database(file);
  raw.exec('ALTER TABLE messages DROP COLUMN search_results');
  raw.pragma('user_version = 7');
  raw.close();
  db = new CipherDb(file);
  assert.equal(db.listMessages(chat.id).length, 2);
  db.close();
  const check = new Database(file);
  assert.equal(check.pragma('user_version', { simple: true }), 14); // current schema (v14 since v1.24)
  check.close();
});

test('5. Settings: Online state and last search time; the settings key holds only the time (history is its own table, v1.19)', () => {
  assert.match(main, /onSend: \(\) => \{\s*const at = new Date\(\)\.toISOString\(\);\s*db\.setSetting\(LAST_SEARCH_KEY, at\);\s*db\.addSearchHistory\(query, at\);/);
  const settingWrites = main.match(/setSetting\(LAST_SEARCH_KEY[^\n]*/g)!;
  assert.equal(settingWrites.length, 1);
  assert.doesNotMatch(settingWrites[0].replace(/db\.addSearchHistory\(query, at\)/, ''), /query/);
  assert.match(html, /<span id="online-state"><\/span>/);
  assert.match(html, /Last search: <span id="last-search">never<\/span>/);
  assert.match(html, /src="assets\/cipher-online-on\.svg"/);
  assert.match(renderer, /el\.lastSearch\.textContent = state\.lastSearch \?/);
  assert.match(renderer, /el\.onlineOnIcon\.hidden = !state\.online;/);
  assert.match(renderer, /icon\.src = 'assets\/cipher-search-result\.svg'/);
  for (const f of ['cipher-online-on.svg', 'cipher-search-result.svg']) {
    assert.ok(fs.existsSync(path.join(root, 'src/renderer/assets', f)), f);
    assert.doesNotMatch(read(`src/renderer/assets/${f}`), /<script|href=|https?:\/\/(?!www\.w3\.org)/);
  }
});

test('5. Policy: query and IP address go to DuckDuckGo, only after Search; history is local and clearable; who never searches', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const policy = require('../renderer/policy.js') as { POLICY_SECTIONS: readonly { heading: string; paragraphs: string[] }[] };
  const s = policy.POLICY_SECTIONS.find((x) => x.heading === 'Web search')!.paragraphs.join('\n');
  assert.match(s, /Nothing is sent unless you press Search/);
  assert.match(s, /the search words and your computer's IP address go to DuckDuckGo \(html\.duckduckgo\.com\)/);
  assert.match(s, /kept only in cipher\.db on this computer\. Clear search history deletes them for good/);
  assert.match(s, /Routines, rooms and a locked Cipher Bot never search/);
  assert.match(s, /The phone can never turn Online on or off/);
  assert.match(s, /scripts never run, and its links and images are never loaded/);
  assert.match(s, /only when you click it, and only while Online is on/);
});
