// v1.17: remember the window's size, position and maximized state in userData/window-state.json (local only).
import fs from 'node:fs';
import path from 'node:path';

export interface Rect { x: number; y: number; width: number; height: number }
export interface WindowState extends Rect { maximized: boolean }

export const WINDOW_STATE_FILE = 'window-state.json';
export const DEFAULT_SIZE = { width: 1100, height: 760 };
export const MIN_SIZE = { width: 760, height: 480 };
/** How long to wait after the last move/resize before saving. */
export const SAVE_DEBOUNCE_MS = 500;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);

/** Parse a saved state; anything malformed gives null (use the default). */
export function parseWindowState(raw: unknown): WindowState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const x = num(r.x), y = num(r.y), width = num(r.width), height = num(r.height);
  if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) return null;
  return { x, y, width, height, maximized: r.maximized === true };
}

/**
 * Fit a saved state onto the current displays. The window keeps its size (shrunk to fit and never below the minimum)
 * and is moved fully inside the display it overlaps most. If it overlaps no display at all, null: use the default.
 */
export function clampToDisplays(saved: WindowState, workAreas: readonly Rect[]): WindowState | null {
  let best: Rect | null = null;
  let bestArea = 0;
  for (const a of workAreas) {
    const w = Math.min(saved.x + saved.width, a.x + a.width) - Math.max(saved.x, a.x);
    const h = Math.min(saved.y + saved.height, a.y + a.height) - Math.max(saved.y, a.y);
    const area = w > 0 && h > 0 ? w * h : 0;
    if (area > bestArea) { bestArea = area; best = a; }
  }
  if (!best) return null;
  const width = Math.max(MIN_SIZE.width, Math.min(saved.width, best.width));
  const height = Math.max(MIN_SIZE.height, Math.min(saved.height, best.height));
  const x = Math.min(Math.max(saved.x, best.x), best.x + best.width - width);
  const y = Math.min(Math.max(saved.y, best.y), best.y + best.height - height);
  return { x, y, width, height, maximized: saved.maximized };
}

export function loadWindowState(dir: string, workAreas: readonly Rect[]): WindowState | null {
  try {
    const saved = parseWindowState(JSON.parse(fs.readFileSync(path.join(dir, WINDOW_STATE_FILE), 'utf8')));
    return saved ? clampToDisplays(saved, workAreas) : null;
  } catch {
    return null;
  }
}

export function saveWindowState(dir: string, state: WindowState): void {
  const file = path.join(dir, WINDOW_STATE_FILE);
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, file);
  } catch {
    // Not being able to remember the window is never an error the user needs to see.
  }
}

/** Calls `fn` once, `ms` after the last call. */
export function debounce(fn: () => void, ms: number): { call: () => void; flush: () => void } {
  let t: ReturnType<typeof setTimeout> | null = null;
  return {
    call: () => { if (t) clearTimeout(t); t = setTimeout(() => { t = null; fn(); }, ms); },
    flush: () => { if (t) { clearTimeout(t); t = null; fn(); } },
  };
}
