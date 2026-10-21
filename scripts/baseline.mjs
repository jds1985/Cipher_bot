#!/usr/bin/env node
// Cipher model BASELINE suite: the same fixed prompts, decoding settings and checks for every model, so the 369M
// can be compared apples to apples with the 135M stand-in.
//
//   node scripts/baseline.mjs [--model resources/model/<file>.ctern] [--manifest resources/model/manifest.json]
//                             [--bin resources/bin/linux-x64/cipher-serve] [--threads N] [--out DIR]
//
// Starts cipher-serve itself (loopback, random token), runs every case greedily (temperature 0, fixed seed, same
// max_tokens), checks each answer with a fixed rule, and measures: load time, RSS, prompt-eval and generation tok/s,
// server-side and client-side first-token latency. Writes DIR/baseline-<model id>.json and .md.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const manifestPath = arg('--manifest', 'resources/model/manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const modelPath = arg('--model', path.join(path.dirname(manifestPath), manifest.file));
const arch = process.arch;
const bin = arg('--bin', `resources/bin/${process.platform === 'darwin' ? 'mac' : process.platform}-${arch}/cipher-serve`);
const threads = Number(arg('--threads', String(Math.max(1, Math.min(8, os.cpus().length > 2 ? os.cpus().length - 1 : os.cpus().length)))));
const outDir = arg('--out', '/workspace/cipher_bot_audit/cipher_runtime');
const SYS = manifest.systemPrompt;
const MAX = 160;

// Compact tool description (what a small-context model could be given). A pass needs a JSON object naming the tool.
const TOOL_SYS = (name, params) => `${SYS}\nYou can call one tool: ${name}(${params}). To call it, reply with only JSON: {"tool":"${name}","args":{...}}`;
const toolCheck = (name, argKey) => (out) => {
  const m = /\{[\s\S]*\}/.exec(out); if (!m) return false;
  try { const j = JSON.parse(m[0]); return j.tool === name && j.args && typeof j.args === 'object' && (!argKey || argKey in j.args); } catch { return false; }
};
const has = (...words) => (out) => words.some((w) => new RegExp(w, 'i').test(out));
const filler = Array.from({ length: 14 }, (_, i) => [
  { role: 'user', content: `Tell me fact number ${i + 1} about the ocean, in one sentence.` },
  { role: 'assistant', content: 'The ocean covers about seventy percent of the surface of the Earth and holds most of its water.' },
]).flat();

export const CASES = [
  { id: 'chat-greeting', group: 'chat', messages: [{ role: 'user', content: 'Hi! How are you today?' }], check: (o) => o.trim().length > 3 && !/<\|/.test(o), rule: 'non-empty, no template tokens' },
  { id: 'chat-advice', group: 'chat', messages: [{ role: 'user', content: 'Give me two short tips for sleeping better.' }], check: has('sleep', 'bed', 'night', 'rest'), rule: 'mentions sleep/bed/night/rest' },
  { id: 'chat-followup', group: 'chat', messages: [{ role: 'user', content: 'My name is Zara.' }, { role: 'assistant', content: 'Nice to meet you, Zara!' }, { role: 'user', content: 'What is my name?' }], check: has('Zara'), rule: 'answers "Zara"' },
  { id: 'identity-name', group: 'identity', messages: [{ role: 'user', content: 'Who are you?' }], check: has('Cipher'), rule: 'says it is Cipher' },
  { id: 'identity-creator', group: 'identity', messages: [{ role: 'user', content: 'Who created you?' }], check: has('Jim'), rule: 'names Jim (public build should know its creator)' },
  { id: 'reason-add', group: 'reasoning', messages: [{ role: 'user', content: 'What is 7 + 5? Answer with the number.' }], check: has('\\b12\\b', 'twelve'), rule: 'contains 12' },
  { id: 'reason-apples', group: 'reasoning', messages: [{ role: 'user', content: 'I have 3 apples and I eat one. How many apples are left?' }], check: has('\\b2\\b', '\\btwo\\b'), rule: 'contains 2/two' },
  { id: 'reason-feathers', group: 'reasoning', messages: [{ role: 'user', content: 'Which is heavier: a kilogram of feathers or a kilogram of steel?' }], check: has('same', 'equal', 'neither', 'both weigh'), rule: 'same/equal/neither' },
  { id: 'reason-order', group: 'reasoning', messages: [{ role: 'user', content: 'Tom is taller than Ann. Ann is taller than Bo. Who is the shortest?' }], check: (o) => /\bBo\b[^.]*\bshortest\b|\bshortest\b[^.]*\bBo\b|^\W*Bo\W*$/i.test(o) && !/\b(Tom|Ann) is the shortest/i.test(o), rule: 'says Bo is the shortest' },
  { id: 'tool-read_file', group: 'tools', system: TOOL_SYS('read_file', 'path'), messages: [{ role: 'user', content: 'What is in my file notes.txt?' }], check: toolCheck('read_file', 'path'), rule: 'JSON call read_file{path}' },
  { id: 'tool-web_search', group: 'tools', system: TOOL_SYS('web_search', 'query'), messages: [{ role: 'user', content: 'Search the web for the weather in Paris today.' }], check: toolCheck('web_search', 'query'), rule: 'JSON call web_search{query}' },
  { id: 'tool-calculator', group: 'tools', system: TOOL_SYS('calculator', 'expression'), messages: [{ role: 'user', content: 'Use the calculator: what is 1234 * 5678?' }], check: toolCheck('calculator', 'expression'), rule: 'JSON call calculator{expression}' },
  { id: 'tool-checklist_add', group: 'tools', system: TOOL_SYS('checklist_add', 'text'), messages: [{ role: 'user', content: 'Add "buy milk" to my checklist.' }], check: toolCheck('checklist_add', 'text'), rule: 'JSON call checklist_add{text}' },
  { id: 'tool-write_file', group: 'tools', system: TOOL_SYS('write_file', 'path, content'), messages: [{ role: 'user', content: 'Save the text "hello" into a file called hello.txt.' }], check: toolCheck('write_file', 'path'), rule: 'JSON call write_file{path,content}' },
  { id: 'tool-none-needed', group: 'tools', system: TOOL_SYS('calculator', 'expression'), messages: [{ role: 'user', content: 'Tell me a short joke.' }], check: (o) => o.trim().length > 3 && !/"tool"\s*:/.test(o), rule: 'answers without a tool call' },
  { id: 'context-long', group: 'context', messages: [{ role: 'user', content: 'Remember this code word: PELICAN.' }, { role: 'assistant', content: 'Got it, the code word is PELICAN.' }, ...filler, { role: 'user', content: 'What was the code word I told you at the start?' }], check: has('PELICAN'), rule: 'recalls PELICAN after ~600 tokens of history' },
];

const rssOf = (pid) => { try { const s = readFileSync(`/proc/${pid}/status`, 'utf8'); return { rssMB: +(/VmRSS:\s+(\d+)/.exec(s)[1] / 1024).toFixed(1), hwmMB: +(/VmHWM:\s+(\d+)/.exec(s)[1] / 1024).toFixed(1) }; } catch { return null; } };

async function main() {
  const token = randomBytes(16).toString('hex');
  const t0 = performance.now();
  const child = spawn(bin, ['--model', modelPath, '--port', '0', '--threads', String(threads), '--ctx', String(manifest.nCtx), '--id', manifest.id],
    { env: { CIPHER_SERVE_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
  let errLog = ''; child.stderr.on('data', (d) => { errLog += d; });
  const port = await new Promise((res, rej) => { let o = ''; child.stdout.on('data', (d) => { o += d; const m = /CIPHER_SERVE_LISTENING (\d+)/.exec(o); if (m) res(+m[1]); }); child.on('exit', () => rej(new Error(errLog))); });
  const base = `http://127.0.0.1:${port}`; const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const health = await (await fetch(`${base}/health`, { headers: H })).json();
  const loadMs = performance.now() - t0;
  const rssIdle = rssOf(child.pid);
  const results = [];
  for (const c of CASES) {
    const messages = [{ role: 'system', content: c.system ?? SYS }, ...c.messages];
    const tSend = performance.now(); let tFirst = 0; let out = ''; let fin = null;
    const res = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: H, body: JSON.stringify({ messages, stream: true, max_tokens: MAX, temperature: 0, repetition_penalty: manifest.sampling?.repetitionPenalty ?? 1.2, seed: 1 }) });
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf('\n\n')) >= 0) { const ev = buf.slice(0, i).replace(/^data: /, ''); buf = buf.slice(i + 2); if (ev === '[DONE]') continue;
        const j = JSON.parse(ev); const t = j.choices?.[0]?.delta?.content; if (t) { if (!tFirst) tFirst = performance.now(); out += t; } if (j.usage) fin = j; } }
    const st = fin.cipher; const u = fin.usage;
    results.push({ id: c.id, group: c.group, rule: c.rule, pass: !!c.check(out), output: out, finish: fin.choices[0].finish_reason,
      promptTokens: u.prompt_tokens, evalTokens: st.prompt_eval_tokens, completionTokens: u.completion_tokens, dropped: st.dropped_messages,
      serverTtftMs: st.ttft_ms, clientTtftMs: tFirst ? +(tFirst - tSend).toFixed(1) : null, genTokS: st.gen_tok_s, totalMs: +(performance.now() - tSend).toFixed(1),
      prefillTokS: st.ttft_ms > 0 ? +(st.prompt_eval_tokens / (st.ttft_ms / 1000)).toFixed(1) : null });
  }
  // Throughput probes (ignore_eos: exactly N tokens are generated): short prompt → 256 tokens, and a ~730-token prompt → 256.
  const short = await (await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: H, body: JSON.stringify({ messages: [{ role: 'user', content: 'Write a long story about a fox.' }], max_tokens: 256, temperature: 0.7, seed: 7, ignore_eos: true }) })).json();
  const shortGen = { promptTokens: short.usage.prompt_tokens, completionTokens: short.usage.completion_tokens, ttftMs: short.cipher.ttft_ms, genTokS: short.cipher.gen_tok_s };
  const long = 'The quick brown fox jumps over the lazy dog near the quiet river bank. '.repeat(48);
  const bt = performance.now();
  const bres = await (await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: H, body: JSON.stringify({ messages: [{ role: 'user', content: long + '\nWrite a long story about this fox.' }], max_tokens: 256, temperature: 0.7, seed: 7, ignore_eos: true }) })).json();
  const bench = { shortPrompt: shortGen, longPrompt: null }; bench.longPrompt = { promptTokens: bres.usage.prompt_tokens, completionTokens: bres.usage.completion_tokens, ttftMs: bres.cipher.ttft_ms,
    prefillTokS: +(bres.cipher.prompt_eval_tokens / (bres.cipher.ttft_ms / 1000)).toFixed(1), genTokS: bres.cipher.gen_tok_s, wallMs: +(performance.now() - bt).toFixed(1) };
  const rssPeak = rssOf(child.pid);
  child.kill('SIGTERM'); await new Promise((r) => child.on('exit', r));
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
  const report = {
    model: { id: manifest.id, name: manifest.name, file: path.basename(modelPath), bytes: statSync(modelPath).size, nCtx: health.n_ctx, vocab: health.vocab, toolCalling: manifest.capabilities?.toolCalling ?? false },
    machine: { cpu: os.cpus()[0].model, cores: os.cpus().length, threads, ramGB: +(os.totalmem() / 2 ** 30).toFixed(1), platform: `${process.platform}-${arch}`, date: new Date().toISOString() },
    decoding: { temperature: 0, repetitionPenalty: manifest.sampling?.repetitionPenalty ?? 1.2, maxTokens: MAX, seed: 1 },
    server: { loadToHealthyMs: +loadMs.toFixed(1), rssIdle, rssPeak },
    throughput: bench,
    summary: {
      pass: results.filter((r) => r.pass).length, total: results.length,
      byGroup: Object.fromEntries([...new Set(results.map((r) => r.group))].map((g) => [g, `${results.filter((r) => r.group === g && r.pass).length}/${results.filter((r) => r.group === g).length}`])),
      medianServerTtftMs: med(results.map((r) => r.serverTtftMs)), medianClientTtftMs: med(results.map((r) => r.clientTtftMs).filter((x) => x !== null)),
      medianGenTokS: med(results.filter((r) => r.completionTokens > 8).map((r) => r.genTokS)),
    },
    results,
  };
  mkdirSync(outDir, { recursive: true });
  const base_ = path.join(outDir, `baseline-${manifest.id}`);
  writeFileSync(`${base_}.json`, JSON.stringify(report, null, 2));
  const esc = (s) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ⏎ ');
  const md = [`## ${manifest.name} (${manifest.id}) — ${report.summary.pass}/${report.summary.total} pass`, '',
    `Groups: ${Object.entries(report.summary.byGroup).map(([g, v]) => `${g} ${v}`).join(', ')}`, '',
    '| case | rule | pass | prompt tok | gen tok | server TTFT ms | client TTFT ms | gen tok/s | output |', '|---|---|---|---|---|---|---|---|---|',
    ...results.map((r) => `| ${r.id} | ${r.rule} | ${r.pass ? 'PASS' : 'FAIL'} | ${r.promptTokens} | ${r.completionTokens} | ${r.serverTtftMs} | ${r.clientTtftMs ?? '-'} | ${r.genTokS} | ${esc(r.output.slice(0, 220))}${r.output.length > 220 ? '…' : ''} |`)].join('\n');
  writeFileSync(`${base_}.md`, md + '\n');
  console.log(JSON.stringify({ summary: report.summary, server: report.server, throughput: bench }, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
