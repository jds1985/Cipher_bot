// Standalone drone preview page (no server, no app): node scripts/gen-drone-preview.mjs [out.html] [--anim] [--before before32.json]
// Run `npm run build` first; inlines dist/renderer/{hexMark,droneParts,droneTheme}.js and drone.css.
// The builder at the bottom is interactive: click parts / palettes, or type a theme.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith('--') && !a.endsWith('.json')) ?? 'dist/drone_preview.html';
const anim = args.includes('--anim');
const bi = args.indexOf('--before');
const before = bi >= 0 && existsSync(args[bi + 1]) ? JSON.parse(readFileSync(args[bi + 1], 'utf8')) : null;
const strip = (f) => readFileSync(f, 'utf8').replace(/^import [\s\S]*?from .*;$/gm, '').replace(/^export \{\};?$/gm, '').replace(/^export /gm, '');
const js = ['dist/renderer/hexMark.js', 'dist/renderer/droneParts.js', 'dist/renderer/droneTheme.js'].map(strip).join('\n');
const css = readFileSync('src/renderer/drone.css', 'utf8');
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Cipher Bot drones</title><style>
${css}
* { box-sizing: border-box; }
body { margin: 0; width: 1600px; color: #dfe8ff; font: 13px/1.4 "Inter", system-ui, sans-serif; padding: 30px 40px;
  background: radial-gradient(1100px 600px at 75% 0%, #16245a66, transparent), radial-gradient(900px 600px at 0% 100%, #0b4a6a33, transparent), #070b1a; }
h1 { font-weight: 600; letter-spacing: .32em; margin: 0; font-size: 22px; background: linear-gradient(90deg, #4f86ff, #3fd0ff 45%, #c6ff6a); -webkit-background-clip: text; color: transparent; }
.sub { color: #7f8db3; margin: 4px 0 16px; letter-spacing: .04em; }
h2 { font-weight: 500; color: #8fb3ff; margin: 18px 0 9px; font-size: 12px; letter-spacing: .18em; text-transform: uppercase; }
.panel { background: linear-gradient(180deg, rgba(20,30,64,.55), rgba(10,16,36,.55)); border: 1px solid rgba(120,180,255,.13); border-radius: 20px; padding: 16px 20px; box-shadow: 0 0 60px rgba(34,200,232,.05) inset; }
.row { display: flex; gap: 8px; align-items: flex-end; justify-content: space-between; }
.cell { display: flex; flex-direction: column; align-items: center; gap: 5px; }
.lbl { color: #9fb0d8; font-size: 12px; letter-spacing: .05em; text-align: center; } .lbl b { color: #e8f0ff; font-weight: 600; } .lbl i { color: #6f7ea6; font-style: normal; font-size: 11px; }
.grid { display: grid; gap: 18px; }
.rail { display: flex; gap: 10px; align-items: center; margin: 4px 0; }
.chip { display: flex; align-items: center; justify-content: center; background: rgba(8,12,28,.85); border: 1px solid rgba(120,180,255,.12); border-radius: 12px; padding: 5px; }
.rl { color: #7f8db3; font-size: 11px; width: 74px; }
.builder { display: grid; grid-template-columns: 330px 1fr; gap: 22px; align-items: start; }
input.prompt { width: 100%; background: #050817; border: 1px solid rgba(63,208,255,.35); border-radius: 12px; padding: 10px 12px; color: #e8f0ff; font: 14px system-ui; margin-bottom: 8px; outline: none; }
.pick { display: grid; grid-template-columns: 78px 1fr; gap: 8px; align-items: center; margin: 5px 0; }
.opts { display: flex; gap: 6px; flex-wrap: wrap; }
.opt { width: 50px; height: 50px; border-radius: 12px; background: rgba(6,10,24,.85); border: 1px solid rgba(120,180,255,.12); display: flex; align-items: center; justify-content: center; cursor: pointer; padding: 0; }
.opt:hover { border-color: #3fd0ff88; } .opt.on { border-color: #3fd0ff; box-shadow: 0 0 0 1px #3fd0ff55, 0 0 16px #3fd0ff33; }
.sw { width: 26px; height: 26px; border-radius: 50%; border: 2px solid rgba(255,255,255,.1); cursor: pointer; padding: 0; } .sw.on { border-color: #3fd0ff; box-shadow: 0 0 10px #3fd0ff88; }
.states button { background: #0c1430; color: #9fb0d8; border: 1px solid rgba(120,180,255,.2); border-radius: 8px; padding: 4px 10px; margin: 2px; cursor: pointer; font-size: 11px; }
.states button.on { color: #fff; border-color: #3fd0ff; }
.json { font: 11px ui-monospace, monospace; color: #7f8db3; margin-top: 8px; word-break: break-all; }
</style></head><body>
<h1>CIPHER BOT · DRONES</h1><div class="sub">Layered vector parts · 8 presets · offline theme-from-prompt · CSS motion (idle bob, crystal sway, blink, thinking scan, speaking pulse) · v2 polish</div>
<div class="panel"><div class="row" id="hero"></div></div>
<div class="grid" style="grid-template-columns: 430px 1fr"><div><h2>Close-up · Cipher (Hex Circuit mark eye)</h2><div class="panel" id="close" style="display:flex;justify-content:center"></div></div>
<div><h2>App sizes · 44px / 32px (optical small variant)</h2><div class="panel" id="sizes"></div>
<h2>States</h2><div class="panel"><div class="row" id="states"></div></div></div></div>
<h2>Theme from a prompt (offline keyword mapper · negation · two-theme combine · unknown → deterministic hash)</h2><div class="panel"><div class="row" id="themes"></div></div>
<h2>Builder (interactive · click parts or type a theme)</h2><div class="panel builder" id="builder"></div>
<script>
${js}
const BEFORE = ${JSON.stringify(before)};
const $ = (id) => document.getElementById(id);
let uid = 0;
const svg = (spec, size, cls = '') => { const d = document.createElement('div'); d.innerHTML = composeDrone(spec, { size, detail: size <= 48 ? 'small' : 'full', uid: 'u' + (++uid), className: cls + ' ph-' + (uid % 8) }); const s = d.firstElementChild; s.dataset.state = 'idle'; return s; };
const cell = (el, html) => { const c = document.createElement('div'); c.className = 'cell'; c.append(el); if (html) { const l = document.createElement('div'); l.className = 'lbl'; l.innerHTML = html; c.append(l); } return c; };
const names = { cipher: 'Cipher', researcher: 'Researcher', writer: 'Writer', coder: 'Coder', planner: 'Planner', scout: 'Scout', musician: 'Musician', error: 'Error' };
for (const k of DRONE_PRESET_KEYS) $('hero').append(cell(svg(presetSpec(k), 178), '<b>' + names[k] + '</b>'));
$('close').append(cell(svg(presetSpec('cipher'), 360), '<b>Cipher</b> <i>· brand mark, hex bezel, circuit shell</i>'));
const rail = (label, items) => { const r = document.createElement('div'); r.className = 'rail'; const t = document.createElement('div'); t.className = 'rl'; t.textContent = label; r.append(t);
  for (const el of items) { const c = document.createElement('div'); c.className = 'chip'; c.append(el); r.append(c); } $('sizes').append(r); };
rail('44px', DRONE_PRESET_KEYS.map((k) => svg(presetSpec(k), 44)));
rail('32px now', DRONE_PRESET_KEYS.map((k) => svg(presetSpec(k), 32)));
if (BEFORE) rail('32px before', DRONE_PRESET_KEYS.map((k) => { const d = document.createElement('div'); d.innerHTML = BEFORE[k].replace('class="drone ', 'class="drone-old '); return d.firstElementChild; }));
const lr = document.createElement('div'); lr.className = 'rail'; lr.innerHTML = '<div class="rl"></div>' + DRONE_PRESET_KEYS.map((k) => '<div class="lbl" style="width:44px;font-size:10px">' + names[k] + '</div>').join(''); $('sizes').append(lr);
const sts = [['idle', ''], ['thinking', ''], ['speaking', ''], ['muted', 'is-muted'], ['archived', 'is-archived']];
sts.forEach(([s, cls], i) => { const e = svg(presetSpec(DRONE_PRESET_KEYS[i]), 112, cls); e.dataset.state = s === 'muted' || s === 'archived' ? 'idle' : s; $('states').append(cell(e, s)); });
for (const w of ['basketball', 'music', 'space', 'detective', 'gardening', 'fire', 'ocean', 'coding', 'chess', 'coffee', 'basketball and music', "space, not music", 'zorblax']) {
  const r = themeDrone(w); $('themes').append(cell(svg(r.spec, 104), '<b>' + w + '</b><br><i>' + (r.source === 'hash' ? 'hashed fallback' : r.theme) + '</i>')); }
// ---------- interactive builder ----------
let cur = themeDrone('basketball').spec, state = 'idle';
const left = document.createElement('div'), right = document.createElement('div');
left.innerHTML = '<input class="prompt" id="prompt" value="basketball" placeholder="Type a theme: music, space, not coffee…"><div id="big" style="display:flex;justify-content:center"></div><div class="lbl" id="why"></div><div class="states" id="stbtn" style="text-align:center;margin-top:6px"></div><div class="json" id="json"></div>';
$('builder').append(left, right);
const draw = () => {
  const big = svg(cur, 270); big.dataset.state = state === 'muted' || state === 'archived' ? 'idle' : state;
  if (state === 'muted') big.classList.add('is-muted'); if (state === 'archived') big.classList.add('is-archived');
  $('big').replaceChildren(big); $('json').textContent = JSON.stringify(cur); drawPickers();
};
const drawPickers = () => {
  right.replaceChildren();
  const picker = (label, list, key) => { const p = document.createElement('div'); p.className = 'pick'; const l = document.createElement('div'); l.className = 'lbl'; l.style.textAlign = 'left'; l.textContent = label; const o = document.createElement('div'); o.className = 'opts';
    for (const v of list) { const b = document.createElement('button'); const on = key === 'accessories' ? cur.accessories.includes(v) : cur[key] === v; b.className = 'opt' + (on ? ' on' : ''); b.title = v;
      const preview = key === 'accessories' ? { ...cur, accessories: [v] } : { ...cur, accessories: [], [key]: v };
      b.append(svg(preview, 44)); b.onclick = () => {
        if (key === 'accessories') cur = sanitizeSpec({ ...cur, accessories: on ? cur.accessories.filter((a) => a !== v) : [...cur.accessories, v].slice(-3) });
        else cur = sanitizeSpec({ ...cur, [key]: v });
        $('why').textContent = 'custom'; draw(); };
      o.append(b); }
    p.append(l, o); right.append(p); };
  picker('Shell', DRONE_SHELLS, 'shell'); picker('Eye', DRONE_EYES, 'eye'); picker('Fins', DRONE_FINS, 'fins'); picker('Crystal', DRONE_CRYSTALS, 'crystal'); picker('Accessories', DRONE_ACCESSORIES, 'accessories');
  const pp = document.createElement('div'); pp.className = 'pick'; pp.innerHTML = '<div class="lbl" style="text-align:left">Palette</div>'; const po = document.createElement('div'); po.className = 'opts';
  for (const k of DRONE_PALETTE_KEYS) { const p = DRONE_PALETTES[k]; const s = document.createElement('button'); s.className = 'sw' + (k === cur.palette ? ' on' : ''); s.title = p.label;
    s.style.background = 'radial-gradient(circle at 35% 30%, ' + p.hi + ', ' + p.body + ' 45%, ' + p.deep + ')'; s.style.boxShadow = 'inset 0 0 0 2px ' + p.glow + '55';
    s.onclick = () => { cur = sanitizeSpec({ ...cur, palette: k }); draw(); }; po.append(s); }
  pp.append(po); right.append(pp);
};
const applyPrompt = () => { const r = themeDrone($('prompt').value); cur = r.spec; $('why').innerHTML = '<i>' + (r.source === 'hash' ? 'unknown word → hashed parts' : 'theme: ' + r.theme + ' · matched ' + r.matched.join(', ')) + '</i>'; draw(); };
$('prompt').addEventListener('input', applyPrompt);
for (const s of ['idle', 'thinking', 'speaking', 'muted', 'archived']) { const b = document.createElement('button'); b.textContent = s; b.className = s === state ? 'on' : ''; b.onclick = () => { state = s; [...$('stbtn').children].forEach((x) => x.className = x === b ? 'on' : ''); draw(); }; $('stbtn').append(b); }
applyPrompt();
${anim ? `const all = [...document.querySelectorAll('#hero .drone, #close .drone')]; let t = 0; const seq = ['idle', 'thinking', 'speaking', 'idle'];
setInterval(() => { t++; all.forEach((e, i) => { e.dataset.state = seq[(t + i) % 4]; }); }, 1700);` : ''}
</script></body></html>`;
writeFileSync(out, html);
console.log('wrote', out);
