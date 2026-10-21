// v2 animated bot avatars. Each avatar is an inline SVG built from the named parts of Liz's icons
// (botIconSvgs.ts BOT_SHAPE_PARTS): an aura (radial glow), an orbit ring with a satellite, then the figure:
// decoration (antenna, pins), side ports, a glass body with a shine, and a face (eyes + mouth).
// All motion is CSS (avatar.css): breathing, blinks, gaze drift, orbit. JS only switches data-state
// (idle / thinking / speaking) on reply events and retriggers a short mouth "beat" per streamed token, throttled.
// Phase: every bot gets one of 8 phase classes from its id, so no two neighbours move in sync.
// Offscreen avatars are paused (IntersectionObserver adds .av-off). Reduced motion turns all of it off (CSS).
// No inline styles (CSP style-src 'self'): size via attributes, color and phase via classes, gradients via shared defs.
import { BOT_SHAPE_PARTS } from './botIconSvgs.js';
import { BOT_COLORS, BOT_PALETTES, colorOf, shapeOf, type BotColor } from './botIcon.js';

const SVGNS = 'http://www.w3.org/2000/svg';
export type AvatarState = 'idle' | 'thinking' | 'speaking';
export const AVATAR_PHASES = 8;
/** ms without a token after which a speaking avatar goes back to thinking. */
export const SPEAK_HOLD_MS = 450;
/** Minimum ms between mouth beats. */
export const BEAT_MIN_MS = 90;

/** Stable phase 0..7 from a bot id (Knuth multiplicative hash), so neighbours rarely share one. */
export function phaseOf(id: unknown): number {
  const n = typeof id === 'number' && Number.isFinite(id) ? Math.abs(Math.trunc(id)) : 0;
  return (Math.imul(n + 1, 2654435761) >>> 0) % AVATAR_PHASES;
}

/** Gradient defs for every palette, shared by all avatars on the page (ids cav-s/-g/-a/-e-<key>, cav-shine). */
export function avatarDefsMarkup(): string {
  const stops = (list: [number, string, number][]): string =>
    list.map(([o, c, a]) => `<stop offset="${o}" stop-color="${c}" stop-opacity="${a}"/>`).join('');
  let d = `<linearGradient id="cav-shine" x1="0" y1="0" x2="0" y2="1">${stops([[0, '#ffffff', 0.26], [0.42, '#ffffff', 0.05], [0.55, '#ffffff', 0]])}</linearGradient>`;
  for (const k of BOT_COLORS) {
    const { a1, a2 } = BOT_PALETTES[k];
    d += `<linearGradient id="cav-s-${k}" gradientUnits="userSpaceOnUse" x1="24" y1="24" x2="232" y2="232">${stops([[0, a1, 1], [1, a2, 1]])}</linearGradient>`;
    d += `<linearGradient id="cav-g-${k}" x1="0" y1="0" x2="0.35" y2="1">${stops([[0, a1, 0.34], [0.5, '#0b1533', 0.92], [1, '#060914', 0.97]])}</linearGradient>`;
    d += `<radialGradient id="cav-a-${k}" cx="0.5" cy="0.5" r="0.5">${stops([[0, a1, 0.55], [0.55, a2, 0.16], [1, a2, 0]])}</radialGradient>`;
    d += `<radialGradient id="cav-e-${k}" cx="0.4" cy="0.35" r="0.7">${stops([[0, '#ffffff', 1], [1, a2, 1]])}</radialGradient>`;
  }
  return `<svg xmlns="${SVGNS}" class="avatar-defs" width="0" height="0" aria-hidden="true" focusable="false"><defs>${d}</defs></svg>`;
}

function ensureDefs(doc: Document): void {
  if (doc.querySelector('svg.avatar-defs')) return;
  const svg = new DOMParser().parseFromString(avatarDefsMarkup(), 'image/svg+xml').documentElement;
  doc.body.prepend(doc.importNode(svg, true));
}

/** Avatar markup for a shape + palette (trusted: only bundled part strings and whitelisted keys). */
export function avatarMarkup(shape: unknown, color: unknown): string {
  const s = shapeOf(shape);
  const k: BotColor = colorOf(color);
  const p = BOT_SHAPE_PARTS[s];
  const paint = (m: string): string => m.replace(/currentColor/g, `url(#cav-s-${k})`);
  const body = paint(p.body).replace('fill="#15171c"', `fill="url(#cav-g-${k})"`);
  const shine = p.body.replace(/stroke="currentColor"/, 'stroke="none"').replace('fill="#15171c"', 'fill="url(#cav-shine)"');
  const eyes = p.eyes.replace(/fill="currentColor"/g, `fill="url(#cav-e-${k})"`);
  const { a2 } = BOT_PALETTES[k];
  return `<svg xmlns="${SVGNS}" viewBox="-14 -14 284 284">` +
    `<g class="av-aura"><circle cx="128" cy="128" r="140" fill="url(#cav-a-${k})"/></g>` +
    `<g class="av-orbit"><circle class="av-ring" cx="128" cy="128" r="130" fill="none" stroke="url(#cav-s-${k})" stroke-width="3.5" stroke-linecap="round" stroke-dasharray="64 120 14 120 30 469"/>` +
    `<circle class="av-sat" cx="128" cy="-2" r="6.5" fill="${a2}"/></g>` +
    `<g class="av-figure"><g class="av-deco">${paint(p.deco)}</g><g class="av-ports">${paint(p.ports)}</g>` +
    `<g class="av-body">${body}</g><g class="av-shine">${shine}</g>` +
    `<g class="av-face"><g class="av-eyes">${eyes}</g><g class="av-mouth">${paint(p.mouth)}</g></g></g></svg>`;
}

const templates = new Map<string, SVGSVGElement>();
const botStates = new Map<number, AvatarState>();
const speakTimers = new Map<number, ReturnType<typeof setTimeout>>();
const lastBeat = new Map<number, number>();
let observer: IntersectionObserver | null = null;

function observe(svg: SVGSVGElement): void {
  if (typeof IntersectionObserver === 'undefined') return;
  observer ??= new IntersectionObserver((entries) => {
    for (const e of entries) e.target.classList.toggle('av-off', !e.isIntersecting);
  });
  observer.observe(svg);
}

export interface AvatarOptions {
  shape: unknown; color: unknown; size: number;
  botId?: number; muted?: boolean; archived?: boolean;
  /** Extra classes (e.g. 'av-hero', 'av-sm'). */
  extraClass?: string;
}

/** A live avatar element. Decorative (aria-hidden): the bot's name is always shown or labelled nearby. */
export function createAvatar(o: AvatarOptions): SVGSVGElement {
  const doc = document;
  ensureDefs(doc);
  const key = `${shapeOf(o.shape)}|${colorOf(o.color)}`;
  let t = templates.get(key);
  if (!t) {
    t = new DOMParser().parseFromString(avatarMarkup(o.shape, o.color), 'image/svg+xml').documentElement as unknown as SVGSVGElement;
    templates.set(key, t);
  }
  const svg = doc.importNode(t, true);
  svg.setAttribute('width', String(o.size));
  svg.setAttribute('height', String(o.size));
  const cls = ['bot-icon', 'avatar', `c-${colorOf(o.color)}`, `ph-${phaseOf(o.botId ?? 0)}`, `shape-${shapeOf(o.shape)}`];
  if (o.muted) cls.push('is-muted');
  if (o.archived) cls.push('is-archived');
  if (o.extraClass) cls.push(o.extraClass);
  svg.setAttribute('class', cls.join(' '));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.dataset.state = o.botId != null ? (botStates.get(o.botId) ?? 'idle') : 'idle';
  if (o.botId != null) svg.dataset.bot = String(o.botId);
  observe(svg);
  return svg;
}

function applyState(botId: number): void {
  const st = botStates.get(botId) ?? 'idle';
  for (const a of document.querySelectorAll<SVGSVGElement>(`svg.avatar[data-bot="${botId}"]`)) {
    if (a.dataset.state !== st) a.dataset.state = st;
  }
}

/** A reply started (thinking) or ended (idle) for this bot. */
export function setBotActivity(botId: number, active: boolean): void {
  const cur = botStates.get(botId);
  if (active) { if (!cur) { botStates.set(botId, 'thinking'); applyState(botId); } return; }
  const t = speakTimers.get(botId); if (t) clearTimeout(t);
  speakTimers.delete(botId);
  if (cur) { botStates.delete(botId); applyState(botId); }
}

/** A token arrived: speak (mouth beat), and fall back to thinking after SPEAK_HOLD_MS of silence. */
export function avatarToken(botId: number, now = Date.now()): void {
  if (botStates.get(botId) !== 'speaking') { botStates.set(botId, 'speaking'); applyState(botId); }
  const t = speakTimers.get(botId); if (t) clearTimeout(t);
  speakTimers.set(botId, setTimeout(() => {
    speakTimers.delete(botId);
    if (botStates.get(botId) === 'speaking') { botStates.set(botId, 'thinking'); applyState(botId); }
  }, SPEAK_HOLD_MS));
  if (now - (lastBeat.get(botId) ?? 0) < BEAT_MIN_MS) return;
  lastBeat.set(botId, now);
  for (const a of document.querySelectorAll<SVGSVGElement>(`svg.avatar[data-bot="${botId}"]:not(.av-off)`)) {
    const b = a.classList.contains('beat-a');
    a.classList.toggle('beat-a', !b);
    a.classList.toggle('beat-b', b);
  }
}

/** Current state (for tests and rerenders). */
export const avatarStateOf = (botId: number): AvatarState => botStates.get(botId) ?? 'idle';
