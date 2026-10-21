// v3 drone avatars. Each bot's avatar is its DroneSpec (shared/droneParts.ts) composed into an inline SVG:
// sphere shell, glowing eye, fins, crystal pendant, accessories. All motion is CSS (drone.css): bob, crystal sway,
// blinks; thinking = eye scan + spinning arc; speaking = ring pulse, retriggered per streamed token (beat-a/b, throttled).
// Phase: every bot gets one of 8 phase classes from its id, so no two neighbours move in sync.
// Offscreen avatars are paused (IntersectionObserver adds .av-off). Reduced motion turns all of it off (CSS).
// No inline styles (CSP style-src 'self'): size via attributes, colors via attributes + palette classes.
import { composeDrone, sanitizeSpec, specKey } from '../shared/droneParts.js';

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

const templates = new Map<string, { markup: string; prefix: string }>();
const botStates = new Map<number, AvatarState>();
const speakTimers = new Map<number, ReturnType<typeof setTimeout>>();
const lastBeat = new Map<number, number>();
let observer: IntersectionObserver | null = null;
let seq = 0;

function observe(svg: SVGSVGElement): void {
  if (typeof IntersectionObserver === 'undefined') return;
  observer ??= new IntersectionObserver((entries) => {
    for (const e of entries) e.target.classList.toggle('av-off', !e.isIntersecting);
  });
  observer.observe(svg);
}

/** Detail level for a pixel size: the simplified optical variant (no grain, tucked fins) at 48px and below. */
export const droneDetailFor = (size: number): 'full' | 'small' => (size <= 48 ? 'small' : 'full');

/** Drone markup for a spec at a size, with ids made unique per instance (trusted: built only from whitelisted part ids). */
export function droneInstanceMarkup(spec: unknown, size: number, instance: string): string {
  const s = sanitizeSpec(spec);
  const detail = droneDetailFor(size);
  const key = `${specKey(s)}|${detail}`;
  let t = templates.get(key);
  if (!t) {
    const markup = composeDrone(s, { detail });
    t = { markup, prefix: /id="(dr[a-z0-9]+)-/.exec(markup)?.[1] ?? 'dr' };
    templates.set(key, t);
  }
  return t.markup.split(t.prefix + '-').join(`${t.prefix}${instance}-`);
}

export interface AvatarOptions {
  /** The bot's DroneSpec (sanitized here, so anything unknown becomes plain parts). */
  spec: unknown; size: number;
  botId?: number; muted?: boolean; archived?: boolean;
  /** Extra classes (e.g. 'av-hero', 'av-sm'). */
  extraClass?: string;
}

/** A live drone avatar element. Decorative (aria-hidden): the bot's name is always shown or labelled nearby. */
export function createAvatar(o: AvatarOptions): SVGSVGElement {
  const doc = document;
  const parsed = new DOMParser().parseFromString(droneInstanceMarkup(o.spec, o.size, `i${(++seq).toString(36)}`), 'image/svg+xml').documentElement;
  const svg = doc.importNode(parsed, true) as unknown as SVGSVGElement;
  svg.setAttribute('width', String(o.size));
  svg.setAttribute('height', String(o.size));
  const cls = (svg.getAttribute('class') ?? 'drone').split(' ');
  cls.push('bot-icon', 'avatar', `ph-${phaseOf(o.botId ?? 0)}`);
  if (o.muted) cls.push('is-muted');
  if (o.archived) cls.push('is-archived');
  if (o.extraClass) cls.push(o.extraClass);
  svg.setAttribute('class', cls.join(' '));
  svg.removeAttribute('role');
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
