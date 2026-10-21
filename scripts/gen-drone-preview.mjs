// Standalone drone preview page (no server, no app): node scripts/gen-drone-preview.mjs [out.html] [--anim]
// Run `npm run build` first; inlines dist/renderer/{droneParts,droneTheme}.js and drone.css.
import { readFileSync, writeFileSync } from 'node:fs';

const out = process.argv[2] ?? 'dist/drone_preview.html';
const anim = process.argv.includes('--anim');
const strip = (f) => readFileSync(f, 'utf8').replace(/^import [\s\S]*?from .*;$/gm, '').replace(/^export \{\};?$/gm, '').replace(/^export /gm, '');
const js = ['dist/renderer/droneParts.js', 'dist/renderer/droneTheme.js'].map(strip).join('\n');
const css = readFileSync('src/renderer/drone.css', 'utf8');
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Cipher Bot drones</title><style>
${css}
* { box-sizing: border-box; }
body { margin: 0; width: 1600px; color: #dfe8ff; font: 13px/1.4 "Inter", system-ui, sans-serif; padding: 34px 40px;
  background: radial-gradient(1100px 600px at 75% 0%, #16245a66, transparent), radial-gradient(900px 600px at 0% 100%, #0b4a6a33, transparent), #070b1a; }
h1 { font-weight: 600; letter-spacing: .32em; margin: 0; font-size: 22px; background: linear-gradient(90deg, #4f86ff, #3fd0ff 45%, #c6ff6a); -webkit-background-clip: text; color: transparent; }
.sub { color: #7f8db3; margin: 4px 0 18px; letter-spacing: .04em; }
h2 { font-weight: 500; color: #8fb3ff; margin: 22px 0 10px; font-size: 12px; letter-spacing: .18em; text-transform: uppercase; }
.panel { background: linear-gradient(180deg, rgba(20,30,64,.55), rgba(10,16,36,.55)); border: 1px solid rgba(120,180,255,.13); border-radius: 20px; padding: 18px 20px; box-shadow: 0 0 60px rgba(34,200,232,.05) inset; }
.row { display: flex; gap: 10px; align-items: flex-end; justify-content: space-between; }
.cell { display: flex; flex-direction: column; align-items: center; gap: 6px; }
.lbl { color: #9fb0d8; font-size: 12px; letter-spacing: .06em; } .lbl b { color: #e8f0ff; font-weight: 600; } .lbl i { color: #6f7ea6; font-style: normal; font-size: 11px; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
.small .cell { gap: 4px; } .rail { display: flex; gap: 14px; align-items: center; }
.chip { display: flex; align-items: center; gap: 4px; font-size: 11px; background: rgba(8,12,28,.8); border: 1px solid rgba(120,180,255,.12); border-radius: 12px; padding: 5px 10px 5px 5px; }
.builder { display: grid; grid-template-columns: 300px 1fr; gap: 22px; align-items: start; }
.prompt { background: #050817; border: 1px solid rgba(63,208,255,.35); border-radius: 12px; padding: 10px 12px; color: #e8f0ff; font-size: 14px; margin-bottom: 10px; }
.prompt span { color: #6f7ea6; }
.pick { display: grid; grid-template-columns: 82px 1fr; gap: 8px; align-items: center; margin: 6px 0; }
.opts { display: flex; gap: 6px; flex-wrap: wrap; }
.opt { width: 50px; height: 50px; border-radius: 12px; background: rgba(6,10,24,.85); border: 1px solid rgba(120,180,255,.12); display: flex; align-items: center; justify-content: center; }
.opt.on { border-color: #3fd0ff; box-shadow: 0 0 0 1px #3fd0ff55, 0 0 16px #3fd0ff33; }
.sw { width: 26px; height: 26px; border-radius: 50%; border: 2px solid rgba(255,255,255,.1); } .sw.on { border-color: #3fd0ff; box-shadow: 0 0 10px #3fd0ff88; }
.tag { font-size: 10.5px; color: #6f7ea6; text-align: center; }
</style></head><body>
<h1>CIPHER BOT · DRONES</h1><div class="sub">Layered vector parts · 8 presets · offline theme-from-prompt · CSS motion (idle bob, crystal sway, blink, thinking scan, speaking pulse)</div>
<div class="panel"><div class="row" id="hero"></div></div>
<div class="grid2" style="grid-template-columns: 1.55fr 1fr"><div><h2>App sizes · 44px and 32px (optical small variant)</h2><div class="panel small" id="sizes"></div></div>
<div><h2>States</h2><div class="panel" style="height:calc(100% - 44px)"><div class="row" id="states"></div></div></div></div>
<h2>Theme from a word (offline keyword mapper · unknown words → deterministic hash)</h2><div class="panel"><div class="row" id="themes"></div></div>
<h2>Builder mock</h2><div class="panel builder" id="builder"></div>
<script>
${js}
const $ = (id) => document.getElementById(id);
let uid = 0;
const svg = (spec, size, cls = '') => { const d = document.createElement('div'); d.innerHTML = composeDrone(spec, { size, detail: size <= 48 ? 'small' : 'full', uid: 'u' + (++uid), className: cls + ' ph-' + (uid % 8) }); const s = d.firstElementChild; s.dataset.state = 'idle'; return s; };
const cell = (el, html) => { const c = document.createElement('div'); c.className = 'cell'; c.append(el); if (html) { const l = document.createElement('div'); l.className = 'lbl'; l.innerHTML = html; c.append(l); } return c; };
const names = { cipher: 'Cipher', researcher: 'Researcher', writer: 'Writer', coder: 'Coder', planner: 'Planner', scout: 'Scout', musician: 'Musician', error: 'Error' };
for (const k of DRONE_PRESET_KEYS) $('hero').append(cell(svg(presetSpec(k), 182), '<b>' + names[k] + '</b>'));
for (const sz of [44, 32]) { const r = document.createElement('div'); r.className = 'rail'; r.style.marginBottom = '10px';
  const t = document.createElement('div'); t.className = 'lbl'; t.style.width = '38px'; t.textContent = sz + 'px'; r.append(t);
  for (const k of DRONE_PRESET_KEYS) { const c = document.createElement('div'); c.className = 'chip'; c.append(svg(presetSpec(k), sz)); if (false) { const l = document.createElement('span'); l.className = 'lbl'; l.textContent = names[k]; c.append(l); } r.append(c); }
  $('sizes').append(r); }
const sts = [['idle', ''], ['thinking', ''], ['speaking', ''], ['muted', 'is-muted'], ['archived', 'is-archived']];
sts.forEach(([s, cls], i) => { const e = svg(presetSpec(DRONE_PRESET_KEYS[i]), 110, cls); e.dataset.state = s === 'muted' || s === 'archived' ? 'idle' : s; $('states').append(cell(e, s)); });
for (const w of ['basketball', 'music', 'space', 'detective', 'gardening', 'fire', 'ocean', 'coding', 'chess', 'coffee', 'zorblax']) {
  const r = themeDrone(w); $('themes').append(cell(svg(r.spec, 124), '<b>' + w + '</b><br><i>' + (r.source === 'hash' ? 'hashed fallback' : r.theme) + '</i>')); }
// builder
const cur = themeDrone('basketball').spec;
const left = document.createElement('div');
left.innerHTML = '<div class="prompt"><span>Theme ›</span> basketball</div>';
left.append(cell(svg(cur, 260), '<b>Hoops</b> <i>· from "basketball"</i>'));
const right = document.createElement('div');
const picker = (label, list, key, mk) => { const p = document.createElement('div'); p.className = 'pick'; const l = document.createElement('div'); l.className = 'lbl'; l.textContent = label; const o = document.createElement('div'); o.className = 'opts';
  for (const v of list) { const b = document.createElement('div'); const on = Array.isArray(cur[key]) ? cur[key].includes(v) : cur[key] === v; b.className = 'opt' + (on ? ' on' : ''); b.title = v; b.append(mk(v)); o.append(b); }
  p.append(l, o); right.append(p); };
const base = { ...cur, accessories: [] };
picker('Shell', DRONE_SHELLS, 'shell', (v) => svg({ ...base, shell: v }, 44));
picker('Eye', DRONE_EYES, 'eye', (v) => svg({ ...base, eye: v }, 44));
picker('Fins', DRONE_FINS, 'fins', (v) => svg({ ...base, fins: v }, 44));
picker('Crystal', DRONE_CRYSTALS, 'crystal', (v) => svg({ ...base, crystal: v }, 44));
picker('Accessory', DRONE_ACCESSORIES, 'accessories', (v) => svg({ ...base, accessories: [v] }, 44));
const pp = document.createElement('div'); pp.className = 'pick'; pp.innerHTML = '<div class="lbl">Palette</div>'; const po = document.createElement('div'); po.className = 'opts';
for (const k of DRONE_PALETTE_KEYS) { const p = DRONE_PALETTES[k]; const s = document.createElement('div'); s.className = 'sw' + (k === cur.palette ? ' on' : ''); s.title = p.label; s.style.background = 'radial-gradient(circle at 35% 30%, ' + p.hi + ', ' + p.body + ' 45%, ' + p.deep + ')'; s.style.boxShadow = 'inset 0 0 0 2px ' + p.glow + '55'; po.append(s); }
pp.append(po); right.append(pp);
$('builder').append(left, right);
${anim ? `// animated preview: cycle states
const all = [...document.querySelectorAll('#hero .drone')]; let t = 0; const seq = ['idle', 'thinking', 'speaking', 'idle'];
setInterval(() => { t++; all.forEach((e, i) => { e.dataset.state = seq[(t + i) % 4]; }); }, 1700);` : ''}
</script></body></html>`;
writeFileSync(out, html);
console.log('wrote', out);
