// Builds a standalone avatar preview page (no server, no app): node scripts/gen-avatar-preview.mjs [out.html]
// Run `npm run build` first; it inlines dist/renderer/{botIconSvgs,botIcon,avatar}.js and avatar.css.
import { readFileSync, writeFileSync } from 'node:fs';

const out = process.argv[2] ?? 'dist/avatar_preview.html';
const strip = (f) => readFileSync(f, 'utf8').replace(/^import .*$/gm, '').replace(/^export \{\};?$/gm, '').replace(/^export /gm, '');
const js = ['dist/renderer/botIconSvgs.js', 'dist/renderer/botIcon.js', 'dist/renderer/avatar.js'].map(strip).join('\n');
const css = readFileSync('src/renderer/avatar.css', 'utf8');
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Cipher Bot avatars</title><style>
${css}
body { margin: 0; background: radial-gradient(1200px 700px at 70% 10%, #1a1f5a55, transparent), radial-gradient(900px 600px at 10% 90%, #0e6f8a33, transparent), #060914;
  color: #dfe8ff; font: 13px/1.4 system-ui, sans-serif; padding: 24px; }
h1 { font-weight: 600; letter-spacing: .2em; margin: 0 0 4px; } h2 { font-weight: 500; color: #8fb3ff; margin: 26px 0 8px; font-size: 14px; letter-spacing: .08em; text-transform: uppercase; }
.grid { display: grid; gap: 6px 10px; align-items: center; } .lbl { color: #7f8db3; font-size: 11px; text-align: center; }
.glass { background: rgba(18, 28, 58, .55); border: 1px solid rgba(120, 180, 255, .16); border-radius: 18px; padding: 14px; backdrop-filter: blur(16px);
  box-shadow: 0 0 40px rgba(34, 200, 232, .06) inset; display: inline-block; }
.row { display: flex; gap: 22px; align-items: flex-start; flex-wrap: wrap; }
.hero { text-align: center; width: 420px; } .hero p { color: #9fb0d8; }
.bubble { max-width: 380px; margin-top: 8px; padding: 10px 14px; border-radius: 16px; background: rgba(12, 20, 46, .8); border: 1px solid rgba(34, 200, 232, .25); min-height: 40px; text-align: left; }
</style></head><body>
<h1>CIPHER BOT · AVATARS</h1><div class="lbl" style="text-align:left">12 shapes × 8 brand palettes · states: idle, thinking, speaking, muted, archived · CSS motion, per-bot phase</div>
<h2>Hero (live demo: idle → thinking → speaking)</h2><div class="row"><div class="glass hero" id="hero"></div><div class="glass" id="rail"></div></div>
<h2>Palettes × shapes (idle)</h2><div class="glass"><div class="grid" id="pal"></div></div>
<h2>States</h2><div class="glass"><div class="grid" id="states"></div></div>
<script>
${js}
const $ = (id) => document.getElementById(id);
const cell = (el) => { const d = document.createElement('div'); d.append(el); return d; };
const lbl = (t) => { const d = document.createElement('div'); d.className = 'lbl'; d.textContent = t; return d; };
// palettes x shapes
const pal = $('pal'); pal.style.gridTemplateColumns = '90px repeat(' + BOT_SHAPES.length + ', 64px)';
pal.append(lbl('')); for (const s of BOT_SHAPES) pal.append(lbl(s));
let id = 1;
for (const c of BOT_COLORS) { pal.append(lbl(BOT_PALETTES[c].label)); for (const s of BOT_SHAPES) pal.append(cell(createAvatar({ shape: s, color: c, size: 60, botId: id++ }))); }
// states
const st = $('states'); st.style.gridTemplateColumns = '90px repeat(' + BOT_SHAPES.length + ', 64px)';
st.append(lbl('')); for (const s of BOT_SHAPES) st.append(lbl(s));
const states = ['idle', 'thinking', 'speaking', 'muted', 'archived'];
const speakers = [];
states.forEach((state, r) => { st.append(lbl(state)); BOT_SHAPES.forEach((s, i) => {
  const bid = 1000 + r * 100 + i; const c = BOT_COLORS[(i + r) % 8];
  const a = createAvatar({ shape: s, color: c, size: 60, botId: bid, muted: state === 'muted', archived: state === 'archived' });
  st.append(cell(a));
  if (state === 'thinking') setBotActivity(bid, true);
  if (state === 'speaking') { setBotActivity(bid, true); speakers.push(bid); }
}); });
setInterval(() => { for (const b of speakers) if (Math.random() < .7) avatarToken(b); }, 70);
// rail
const rail = $('rail'); const names = ['Cipher', 'Researcher', 'Writer', 'Coder', 'Planner', 'Scout'];
const rs = ['hex', 'circle', 'diamond', 'shield', 'chip', 'antenna'], rc = ['blue', 'cyan', 'violet', 'pink', 'green', 'orange'];
names.forEach((n, i) => { const d = document.createElement('div'); d.style.cssText = 'display:flex;align-items:center;gap:10px;margin:4px 0';
  d.append(createAvatar({ shape: rs[i], color: rc[i], size: 44, botId: 50 + i })); d.append(n); rail.append(d); });
// hero demo loop
const hero = $('hero'); hero.append(createAvatar({ shape: 'hex', color: 'blue', size: 180, botId: 7, extraClass: 'av-hero' }));
const p = document.createElement('p'); p.textContent = 'Say hello to Cipher.'; const bub = document.createElement('div'); bub.className = 'bubble'; hero.append(p, bub);
const text = "Hi Jim! I'm Cipher, running right here on your computer. What should we build today?".split(/(?<= )/);
async function loop() { for (;;) { bub.textContent = ''; p.textContent = 'idle'; await sleep(2600);
  p.textContent = 'thinking…'; setBotActivity(7, true); setBotActivity(53, true); await sleep(2000); p.textContent = 'speaking';
  for (const w of text) { bub.textContent += w; avatarToken(7); avatarToken(53); await sleep(110); }
  await sleep(700); setBotActivity(7, false); setBotActivity(53, false); await sleep(1500); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); loop();
</script></body></html>`;
writeFileSync(out, html);
console.log('wrote', out);
