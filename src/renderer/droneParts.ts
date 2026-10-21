// Drone avatars: a layered, hand-authored vector parts library and a deterministic composer.
// A drone is a sphere shell with panel seams, ONE glowing ring eye in a bezel, two angled side fins,
// a faceted crystal pendant on a short cable, and optional accessories.
// DroneSpec -> SVG string. Same spec (and uid) -> byte-identical SVG. No DOM, no network.
// Colors: emitted as presentation attributes (the app CSP forbids inline styles), and every colored element
// also carries a token class (dr-f-<token> / dr-k-<token> / dr-s-<token>), so drone.css can recolor a drone
// from CSS variables when it has the .dr-themed class (--d-body, --d-deep, --d-hi, --d-glow, --d-glow2, --d-metal).
// Geometry lives in a 256x256 box: sphere at (128,118) r68, eye at (114,122), pendant below to y~248.

export const DRONE_SHELLS = ['plain', 'circuit', 'cracked', 'striped', 'basketball', 'ringed', 'armored', 'glass'] as const;
export const DRONE_EYES = ['ring', 'hex', 'visor', 'iris'] as const;
export const DRONE_FINS = ['blade', 'quill', 'panel', 'wing'] as const;
export const DRONE_CRYSTALS = ['gem', 'prism', 'drop', 'shard'] as const;
export const DRONE_ACCESSORIES = [
  'tophat', 'monocle-cracked', 'monocle-magnifier', 'antenna', 'headphones', 'quill', 'compass',
  'halo', 'crown', 'hoop', 'leaf', 'flame', 'steam', 'chess-crown', 'star',
] as const;

export type DroneShell = typeof DRONE_SHELLS[number];
export type DroneEye = typeof DRONE_EYES[number];
export type DroneFins = typeof DRONE_FINS[number];
export type DroneCrystal = typeof DRONE_CRYSTALS[number];
export type DroneAccessory = typeof DRONE_ACCESSORIES[number];

export interface DronePalette {
  /** mid body tone */ body: string;
  /** shadow tone */ deep: string;
  /** lit highlight on the body */ hi: string;
  /** main glow: eye ring, seams, rim light */ glow: string;
  /** secondary glow: crystal, accents */ glow2: string;
  /** hardware: bezels, hubs */ metal: string;
  label: string;
}

export const DRONE_PALETTES = {
  cipher:   { body: '#1d3f9e', deep: '#081436', hi: '#4f86ff', glow: '#3fd0ff', glow2: '#2f7bff', metal: '#2a3550', label: 'Cipher blue' },
  cyan:     { body: '#1f8fae', deep: '#062a3a', hi: '#6fe3f5', glow: '#7ff2ff', glow2: '#22c8e8', metal: '#26404c', label: 'Researcher cyan' },
  violet:   { body: '#4b2fa8', deep: '#140b3a', hi: '#8f74ff', glow: '#c99bff', glow2: '#8b6cff', metal: '#2e2850', label: 'Writer violet' },
  lime:     { body: '#5a9a22', deep: '#16300a', hi: '#a8e860', glow: '#c6ff6a', glow2: '#8cef60', metal: '#2c3a22', label: 'Coder lime' },
  bronze:   { body: '#6b5236', deep: '#1f170e', hi: '#b08a5c', glow: '#ffb547', glow2: '#ff9a2e', metal: '#3a3026', label: 'Planner bronze' },
  coral:    { body: '#c4505a', deep: '#3a1218', hi: '#ff8c94', glow: '#ff7a7a', glow2: '#ff5c6a', metal: '#4a2a30', label: 'Scout coral' },
  magenta:  { body: '#a43592', deep: '#300c2c', hi: '#f17ad8', glow: '#ff8cf0', glow2: '#e05ad8', metal: '#40243e', label: 'Musician magenta' },
  obsidian: { body: '#1c1c24', deep: '#060608', hi: '#4a4658', glow: '#a066ff', glow2: '#8b4cff', metal: '#2a2630', label: 'Error obsidian' },
  orange:   { body: '#d06a1e', deep: '#3a1606', hi: '#ffa458', glow: '#ffd27a', glow2: '#ff8a2a', metal: '#3a2a20', label: 'Court orange' },
  ember:    { body: '#a8301a', deep: '#2a0804', hi: '#ff7040', glow: '#ffc04a', glow2: '#ff5a1e', metal: '#3a2018', label: 'Ember' },
  ocean:    { body: '#145a86', deep: '#04182c', hi: '#40a8e0', glow: '#5af0e0', glow2: '#1ec8c0', metal: '#1e3446', label: 'Ocean' },
  forest:   { body: '#2a6a3a', deep: '#0a2210', hi: '#6ab86a', glow: '#b6f06a', glow2: '#5ad88a', metal: '#233a28', label: 'Forest' },
  gold:     { body: '#9a7a2a', deep: '#2a1e06', hi: '#e8c860', glow: '#fff0a0', glow2: '#ffd24a', metal: '#3a3220', label: 'Gold' },
  steel:    { body: '#4a5262', deep: '#12161e', hi: '#8a96aa', glow: '#9fe6ff', glow2: '#6ab0ff', metal: '#2a2f3a', label: 'Steel' },
  ice:      { body: '#6a9ac8', deep: '#14243c', hi: '#c8e6ff', glow: '#e6fbff', glow2: '#8ad8ff', metal: '#34465a', label: 'Ice' },
  coffee:   { body: '#5e3e2a', deep: '#1c100a', hi: '#a8785a', glow: '#ffcf8a', glow2: '#e8a060', metal: '#33261e', label: 'Espresso' },
} as const satisfies Record<string, DronePalette>;
export type DronePaletteKey = keyof typeof DRONE_PALETTES;
export const DRONE_PALETTE_KEYS = Object.keys(DRONE_PALETTES) as DronePaletteKey[];

export interface DroneSpec {
  shell: DroneShell;
  palette: DronePaletteKey;
  eye: DroneEye;
  fins: DroneFins;
  crystal: DroneCrystal;
  accessories: DroneAccessory[];
}

/** Human/LLM-readable catalog of the library: an LLM (Cipher) can pick ids from this and pass JSON to sanitizeSpec. */
export const DRONE_LIBRARY = {
  shells: {
    plain: 'smooth sphere with panel seams', circuit: 'Cipher circuit traces and glowing nodes', cracked: 'cracked obsidian with glowing fissures',
    striped: 'glowing equator bands (music, speed)', basketball: 'basketball seams', ringed: 'planet ring around the sphere (space)',
    armored: 'heavy plates and rivets', glass: 'clear glass sphere with a glowing core',
  } satisfies Record<DroneShell, string>,
  eyes: { ring: 'glowing ring eye in a round bezel', hex: 'ring eye in the Cipher hex bezel', visor: 'wide code visor showing { }', iris: 'living iris eye' } satisfies Record<DroneEye, string>,
  fins: { blade: 'angled blade fins', quill: 'feather quill fin', panel: 'flat panel fins with trim', wing: 'small swept wings' } satisfies Record<DroneFins, string>,
  crystals: { gem: 'faceted gem', prism: 'rainbow prism', drop: 'teardrop crystal', shard: 'long shard' } satisfies Record<DroneCrystal, string>,
  accessories: {
    tophat: 'top hat', 'monocle-cracked': 'cracked monocle on a chain', 'monocle-magnifier': 'magnifier monocle (research, detective)',
    antenna: 'antenna with a beacon tip', headphones: 'headphones', quill: 'quill pen tucked behind', compass: 'tilted compass ring with ticks',
    halo: 'glowing halo', crown: 'crown of glowing nodes', hoop: 'mini basketball hoop orbiting', leaf: 'sprout leaves (gardening)',
    flame: 'flame crest (fire)', steam: 'steam wisps (coffee, tea)', 'chess-crown': 'chess king cross', star: 'small orbiting star',
  } satisfies Record<DroneAccessory, string>,
  palettes: Object.fromEntries(DRONE_PALETTE_KEYS.map((k) => [k, DRONE_PALETTES[k].label])) as Record<DronePaletteKey, string>,
};

const pick = <T extends string>(list: readonly T[], v: unknown, d: T): T => (list as readonly unknown[]).includes(v) ? v as T : d;

/** Turn anything (e.g. JSON from an LLM) into a valid DroneSpec; unknown values fall back to plain parts. */
export function sanitizeSpec(x: unknown): DroneSpec {
  const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
  const acc = Array.isArray(o.accessories) ? o.accessories : [];
  const accessories = [...new Set(acc.filter((a): a is DroneAccessory => (DRONE_ACCESSORIES as readonly unknown[]).includes(a)))].slice(0, 3);
  return {
    shell: pick(DRONE_SHELLS, o.shell, 'plain'), palette: pick(DRONE_PALETTE_KEYS, o.palette, 'cipher'), eye: pick(DRONE_EYES, o.eye, 'ring'),
    fins: pick(DRONE_FINS, o.fins, 'blade'), crystal: pick(DRONE_CRYSTALS, o.crystal, 'gem'), accessories,
  };
}

export const DRONE_PRESETS = {
  cipher:     { shell: 'circuit', palette: 'cipher', eye: 'hex', fins: 'panel', crystal: 'gem', accessories: [] },
  researcher: { shell: 'plain', palette: 'cyan', eye: 'ring', fins: 'blade', crystal: 'gem', accessories: ['monocle-magnifier'] },
  writer:     { shell: 'plain', palette: 'violet', eye: 'ring', fins: 'quill', crystal: 'gem', accessories: [] },
  coder:      { shell: 'plain', palette: 'lime', eye: 'visor', fins: 'blade', crystal: 'gem', accessories: [] },
  planner:    { shell: 'armored', palette: 'bronze', eye: 'ring', fins: 'panel', crystal: 'gem', accessories: ['compass'] },
  scout:      { shell: 'plain', palette: 'coral', eye: 'ring', fins: 'blade', crystal: 'gem', accessories: ['antenna'] },
  musician:   { shell: 'striped', palette: 'magenta', eye: 'ring', fins: 'blade', crystal: 'gem', accessories: ['headphones'] },
  error:      { shell: 'cracked', palette: 'obsidian', eye: 'iris', fins: 'wing', crystal: 'prism', accessories: ['tophat', 'monocle-cracked'] },
} as const satisfies Record<string, DroneSpec>;
export type DronePresetKey = keyof typeof DRONE_PRESETS;
export const DRONE_PRESET_KEYS = Object.keys(DRONE_PRESETS) as DronePresetKey[];
export const presetSpec = (k: DronePresetKey): DroneSpec => sanitizeSpec(DRONE_PRESETS[k]);

/** FNV-1a 32-bit. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
export const specKey = (s: DroneSpec): string => [s.shell, s.palette, s.eye, s.fins, s.crystal, ...s.accessories].join('.');

// ---------------------------------------------------------------------------------------------------------
// Drawing. Each part returns markup for back / mid / front layers. `P` holds ids and colors for one drone.

type Tok = 'body' | 'deep' | 'hi' | 'glow' | 'glow2' | 'metal';
interface Ctx { id: (n: string) => string; url: (n: string) => string; c: Record<Tok, string>; small: boolean; }
interface Layers { back?: string; mid?: string; front?: string; }

const CX = 128, CY = 118, R = 68, EX = 114, EY = 122;
const fill = (P: Ctx, t: Tok, extra = ''): string => `fill="${P.c[t]}" class="dr-f-${t}"${extra}`;
const stroke = (P: Ctx, t: Tok, w: number, extra = ''): string => `fill="none" stroke="${P.c[t]}" stroke-width="${w}" class="dr-k-${t}"${extra}`;
const stop = (P: Ctx, o: number, t: Tok | string, a = 1): string =>
  t.startsWith('#') ? `<stop offset="${o}" stop-color="${t}" stop-opacity="${a}"/>` : `<stop offset="${o}" stop-color="${P.c[t as Tok]}" stop-opacity="${a}" class="dr-s-${t}"/>`;

function defs(P: Ctx): string {
  return `<defs>
<radialGradient id="${P.id('shell')}" cx="0.36" cy="0.28" r="0.82">${stop(P, 0, 'hi')}${stop(P, 0.38, 'body')}${stop(P, 0.8, 'deep')}${stop(P, 1, '#020308')}</radialGradient>
<linearGradient id="${P.id('rim')}" x1="0.15" y1="0.1" x2="0.85" y2="0.95">${stop(P, 0, 'glow', 0)}${stop(P, 0.55, 'glow', 0)}${stop(P, 1, 'glow', 0.95)}</linearGradient>
<linearGradient id="${P.id('rimtop')}" x1="0" y1="0" x2="0.6" y2="0.7">${stop(P, 0, '#ffffff', 0.55)}${stop(P, 0.35, '#ffffff', 0)}</linearGradient>
<radialGradient id="${P.id('spec')}" cx="0.5" cy="0.5" r="0.5">${stop(P, 0, '#ffffff', 0.5)}${stop(P, 1, '#ffffff', 0)}</radialGradient>
<linearGradient id="${P.id('fin')}" x1="0" y1="0" x2="0.4" y2="1">${stop(P, 0, 'hi')}${stop(P, 0.45, 'body')}${stop(P, 1, 'deep')}</linearGradient>
<linearGradient id="${P.id('finshade')}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset=".45" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".45"/></linearGradient>
<linearGradient id="${P.id('bezel')}" x1="0.2" y1="0" x2="0.8" y2="1">${stop(P, 0, '#c4ccdc')}${stop(P, 0.3, 'metal')}${stop(P, 0.62, '#07090f')}${stop(P, 1, '#8a94a8')}</linearGradient>
<radialGradient id="${P.id('lens')}" cx="0.45" cy="0.4" r="0.6">${stop(P, 0, 'glow', 0.35)}${stop(P, 0.55, '#071022')}${stop(P, 1, '#020308')}</radialGradient>
<radialGradient id="${P.id('iris')}" cx="0.5" cy="0.5" r="0.5">${stop(P, 0, '#ffffff')}${stop(P, 0.25, 'glow')}${stop(P, 0.7, 'glow2')}${stop(P, 1, 'deep')}</radialGradient>
<linearGradient id="${P.id('gold')}" x1="0" y1="0" x2="1" y2="1">${stop(P, 0, '#ffe7a8')}${stop(P, 0.45, '#c8923a')}${stop(P, 1, '#6a4416')}</linearGradient>
<linearGradient id="${P.id('gem')}" x1="0" y1="0" x2="1" y2="1">${stop(P, 0, '#ffffff', 0.9)}${stop(P, 0.3, 'glow')}${stop(P, 1, 'glow2')}</linearGradient>
<linearGradient id="${P.id('prism')}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffb347"/><stop offset="0.35" stop-color="#ff5ca8"/><stop offset="0.6" stop-color="#7b6cff"/><stop offset="1" stop-color="#19b8a8"/></linearGradient>
<radialGradient id="${P.id('aura')}" cx="0.5" cy="0.5" r="0.5">${stop(P, 0, 'glow', 0.22)}${stop(P, 0.6, 'glow2', 0.06)}${stop(P, 1, 'glow2', 0)}</radialGradient>
<clipPath id="${P.id('clip')}"><circle cx="${CX}" cy="${CY}" r="${R}"/></clipPath>
<filter id="${P.id('glow')}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${P.small ? 2.4 : 3.2}"/></filter>
<filter id="${P.id('soft')}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.4"/></filter>
<filter id="${P.id('shadow')}" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="6"/></filter>
</defs>`;
}

/** Glowing line: blurred wide copy under a crisp line. */
const glowLine = (P: Ctx, d: string, w: number, t: Tok = 'glow', a = 0.9): string =>
  `<path d="${d}" ${stroke(P, t, w * 2.6, ` opacity="${a * 0.55}" filter="url(#${P.id('glow')})" stroke-linecap="round"`)}/>`
  + `<path d="${d}" ${stroke(P, t, w, ` opacity="${a}" stroke-linecap="round" stroke-linejoin="round"`)}/>`;
const seam = (P: Ctx, d: string, w = 1.8): string =>
  `<path d="${d}" fill="none" stroke="#02040a" stroke-width="${P.small ? w * 1.5 : w}" stroke-linecap="round" opacity=".7"/>`
  + `<path d="${d}" ${stroke(P, 'hi', 0.8, ' opacity=".35" transform="translate(0.6 1.3)"')}/>`
  + (P.small ? '' : `<path d="${d}" ${stroke(P, 'glow', 2.4, ` opacity=".16" filter="url(#${P.id('soft')})"`)}/>`);

const SEAMS = {
  meridian: 'M150,51 C186,82 190,150 154,186',
  meridianL: 'M96,54 C72,82 68,136 88,176',
  upper: 'M61,102 C100,90 160,90 196,104',
  lower: 'M62,144 C100,164 160,162 195,140',
};

// ----- shells ------------------------------------------------------------------------------------------------
function sphereBase(P: Ctx, opts: { glass?: boolean } = {}): string {
  const a = opts.glass ? ' opacity=".55"' : '';
  return `<circle cx="${CX}" cy="${CY}" r="${R}" fill="url(#${P.id('shell')})"${a}/>`;
}
function sphereShade(P: Ctx): string {
  return `<g clip-path="url(#${P.id('clip')})">`
    + `<ellipse cx="${CX + 26}" cy="${CY + 40}" rx="70" ry="46" fill="#000" opacity=".35" filter="url(#${P.id('shadow')})"/>`
    + `<ellipse cx="${CX - 26}" cy="${CY - 38}" rx="30" ry="18" fill="url(#${P.id('spec')})" transform="rotate(-28 ${CX - 26} ${CY - 38})" opacity="${P.small ? 0.5 : 0.75}"/>`
    + `</g>`
    + `<circle cx="${CX}" cy="${CY}" r="${R - 1.2}" fill="none" stroke="url(#${P.id('rim')})" stroke-width="${P.small ? 3.4 : 2.6}"/>`
    + `<circle cx="${CX}" cy="${CY}" r="${R - 1}" fill="none" stroke="url(#${P.id('rimtop')})" stroke-width="1.6"/>`
    + `<circle cx="${CX}" cy="${CY}" r="${R + 0.6}" fill="none" stroke="#000" stroke-opacity=".6" stroke-width="1.2"/>`;
}
function clipped(P: Ctx, s: string): string { return `<g clip-path="url(#${P.id('clip')})">${s}</g>`; }

function shell(P: Ctx, k: DroneShell): Layers {
  const base = sphereBase(P, { glass: k === 'glass' });
  const std = seam(P, SEAMS.meridian) + seam(P, SEAMS.upper) + (P.small ? '' : seam(P, SEAMS.lower) + seam(P, SEAMS.meridianL, 1.8));
  switch (k) {
    case 'plain': return { mid: base + clipped(P, std) + sphereShade(P) };
    case 'circuit': {
      const traces = P.small
        ? 'M158,70 h10 l10,10 v14 M176,128 h8 l8,-8'
        : 'M158,64 h10 l10,10 v16 M166,92 h12 l8,8 v12 M176,130 h8 l9,-9 M150,160 l10,-10 h14 M80,70 l10,8 h10 M70,150 h10 l8,8';
      const nodes = (P.small ? [[178, 94], [192, 120]] : [[178, 90], [186, 112], [193, 121], [174, 150], [100, 78], [88, 158]])
        .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="${P.small ? 3 : 2.4}" ${fill(P, 'glow')}/>`).join('');
      return { mid: base + clipped(P, std + glowLine(P, traces, P.small ? 2.2 : 1.4, 'glow', 0.85) + nodes) + sphereShade(P) };
    }
    case 'cracked': {
      const cracks = 'M120,51 l5,13 l-9,9 l11,12 l-4,8 M168,62 l-8,12 l6,9 l-10,10 M186,140 l-14,4 l-6,12 l-12,2 M74,96 l12,6 l2,12 M96,176 l8,-12 l12,-2';
      return { mid: base + clipped(P, seam(P, SEAMS.meridian, 2) + `<path d="${cracks}" fill="none" stroke="#000" stroke-width="2.6" stroke-linejoin="round"/>`
        + glowLine(P, cracks, P.small ? 1.6 : 0.9, 'glow', 0.7)) + sphereShade(P) };
    }
    case 'striped': {
      const band = (d: string, w: number): string => `<path d="${d}" ${stroke(P, 'glow2', w, ' opacity=".55"')}/>` + glowLine(P, d, 1.2, 'glow', 0.8);
      return { mid: base + clipped(P, std + band('M60,112 C100,124 160,124 196,110', P.small ? 6 : 5) + (P.small ? '' : band('M64,130 C100,144 160,144 194,128', 3))) + sphereShade(P) };
    }
    case 'basketball': {
      const d = 'M128,50 C112,90 112,146 128,186 M60,118 C100,128 156,128 196,118 M76,72 C104,98 104,140 78,166 M180,72 C152,98 152,140 178,166';
      return { mid: base + clipped(P, `<path d="${d}" fill="none" stroke="#120804" stroke-width="${P.small ? 4.4 : 3.4}" stroke-linecap="round"/>`
        + `<path d="${d}" ${stroke(P, 'glow', 0.8, ' opacity=".25" transform="translate(0 1.6)"')}/>`) + sphereShade(P) };
    }
    case 'ringed': {
      const tr = `rotate(-14 ${CX} ${CY})`;
      const ring = (half: 'back' | 'front'): string => {
        const d = half === 'back' ? `M${CX - 108},${CY} A108,24 0 0 1 ${CX + 108},${CY}` : `M${CX - 108},${CY} A108,24 0 0 0 ${CX + 108},${CY}`;
        return `<g transform="${tr}"><path d="${d}" ${stroke(P, 'glow2', 9, ' opacity=".35"')}/><path d="${d}" ${stroke(P, 'glow', 2.2, ' opacity=".9"')}/>`
          + `<path d="${d}" ${stroke(P, 'glow', 6, ` opacity=".35" filter="url(#${P.id('glow')})"`)}/></g>`;
      };
      return { back: ring('back'), mid: base + clipped(P, std) + sphereShade(P), front: ring('front') };
    }
    case 'armored': {
      const plates = seam(P, SEAMS.meridian, 3.4) + seam(P, SEAMS.upper, 3.4) + seam(P, SEAMS.lower, 3.4) + seam(P, 'M84,64 C72,90 68,130 82,170', 3)
        + `<path d="M72,96 C96,80 140,78 170,90" ${stroke(P, 'hi', 5, ' opacity=".25" stroke-linecap="round"')}/>`;
      const rivets = P.small ? '' : [[150, 62], [176, 84], [186, 120], [174, 158], [70, 112], [92, 160], [120, 92], [150, 94]]
        .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="2.1" fill="#0a0806"/><circle cx="${x - 0.5}" cy="${y - 0.6}" r="1" ${fill(P, 'hi', ' opacity=".8"')}/>`).join('');
      return { mid: base + clipped(P, plates + rivets) + sphereShade(P) };
    }
    case 'glass': {
      const core = `<circle cx="${CX}" cy="${CY}" r="40" ${fill(P, 'glow', ` opacity=".28" filter="url(#${P.id('shadow')})"`)}/>`
        + `<circle cx="${CX}" cy="${CY}" r="${R - 8}" ${stroke(P, 'glow', 1, ' opacity=".3"')}/>`;
      return { mid: base + core + clipped(P, seam(P, SEAMS.upper, 1.6)) + sphereShade(P) };
    }
  }
}

// ----- eyes ----------------------------------------------------------------------------------------------
function ringGlow(P: Ctx, r: number): string {
  const w = P.small ? 7 : 5;
  return `<g class="dr-lid"><circle cx="${EX}" cy="${EY}" r="${r}" ${stroke(P, 'glow', w * 2.2, ` opacity=".6" filter="url(#${P.id('glow')})"`)}/>`
    + `<circle cx="${EX}" cy="${EY}" r="${r}" ${stroke(P, 'glow', w)}/>`
    + `<circle cx="${EX}" cy="${EY}" r="${r}" fill="none" stroke="#ffffff" stroke-width="${w * 0.3}" opacity=".75"/></g>`
    + `<circle class="dr-scan" cx="${EX}" cy="${EY}" r="${r + 6}" ${stroke(P, 'glow', 1.6, ' stroke-dasharray="14 120" stroke-linecap="round"')}/>`;
}
function ticks(P: Ctx, r1: number, r2: number): string {
  if (P.small) return '';
  let d = '';
  for (let i = 0; i < 32; i++) { const a = (i / 32) * Math.PI * 2; d += `M${(EX + Math.cos(a) * r1).toFixed(1)},${(EY + Math.sin(a) * r1).toFixed(1)}L${(EX + Math.cos(a) * r2).toFixed(1)},${(EY + Math.sin(a) * r2).toFixed(1)}`; }
  return `<path d="${d}" ${stroke(P, 'glow', 0.8, ' opacity=".28"')}/>`;
}
const hexPts = (cx: number, cy: number, r: number): string =>
  [0, 1, 2, 3, 4, 5].map((i) => { const a = Math.PI / 6 + (i * Math.PI) / 3; return `${(cx + Math.cos(a) * r).toFixed(1)},${(cy + Math.sin(a) * r).toFixed(1)}`; }).join(' ');

function eye(P: Ctx, k: DroneEye): Layers {
  const shadow = `<circle cx="${EX + 3}" cy="${EY + 5}" r="34" fill="#000" opacity=".55" filter="url(#${P.id('soft')})"/>`;
  const roundBezel = (r: number): string => shadow
    + `<circle cx="${EX}" cy="${EY}" r="${r}" fill="url(#${P.id('bezel')})"/>`
    + `<circle cx="${EX}" cy="${EY}" r="${r - 4}" fill="#05070d"/>`
    + `<circle cx="${EX}" cy="${EY}" r="${r - 6}" fill="url(#${P.id('lens')})"/>`
    + `<circle cx="${EX}" cy="${EY}" r="${r}" fill="none" stroke="#ffffff" stroke-opacity=".25" stroke-width="0.8"/>`;
  const glint = `<ellipse cx="${EX - 9}" cy="${EY - 11}" rx="6" ry="3.5" fill="#fff" opacity=".35" transform="rotate(-30 ${EX - 9} ${EY - 11})"/>`;
  switch (k) {
    case 'ring':
      return { front: `<g class="dr-eye">${roundBezel(32)}${ticks(P, 19, 23)}${ringGlow(P, 13)}<circle cx="${EX}" cy="${EY}" r="6" fill="#030510"/>${glint}</g>` };
    case 'hex': {
      const hex = `<polygon points="${hexPts(EX, EY, 34)}" fill="url(#${P.id('bezel')})" stroke="#000" stroke-width="1"/>`
        + `<polygon points="${hexPts(EX, EY, 29)}" fill="#05070d"/><circle cx="${EX}" cy="${EY}" r="24" fill="url(#${P.id('lens')})"/>`
        + `<polygon points="${hexPts(EX, EY, 31.5)}" ${stroke(P, 'glow', 1.2, ' opacity=".7"')}/>`
        + (P.small ? '' : `<path d="M${EX + 28},${EY - 14} l10,-6 M${EX + 29},${EY + 12} l9,6" ${stroke(P, 'glow', 1.4, ' opacity=".8"')}/>`);
      return { front: `<g class="dr-eye">${shadow}${hex}${ticks(P, 18, 21)}${ringGlow(P, 13)}<circle cx="${EX}" cy="${EY}" r="6" fill="#030510"/>${glint}</g>` };
    }
    case 'visor': {
      const x = EX - 40, y = EY - 19, w = 84, h = 38;
      const braces = `M${EX - 8},${EY - 11} q-6,0 -6,5 v3 q0,3 -5,3 q5,0 5,3 v3 q0,5 6,5 M${EX + 12},${EY - 11} q6,0 6,5 v3 q0,3 5,3 q-5,0 -5,3 v3 q0,5 -6,5`;
      return { front: `<g class="dr-eye"><rect x="${x + 3}" y="${y + 5}" width="${w}" height="${h}" rx="19" fill="#000" opacity=".55" filter="url(#${P.id('soft')})"/>`
        + `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="19" fill="url(#${P.id('gold')})"/>`
        + `<rect x="${x + 4}" y="${y + 4}" width="${w - 8}" height="${h - 8}" rx="15" fill="#04080a"/>`
        + `<rect x="${x + 6}" y="${y + 6}" width="${w - 12}" height="${h - 12}" rx="13" fill="url(#${P.id('lens')})"/>`
        + `<g class="dr-lid">${glowLine(P, braces, P.small ? 4 : 2.8, 'glow', 1)}</g>`
        + `<rect class="dr-scan" x="${x + 10}" y="${EY - 1}" width="${w - 20}" height="2" rx="1" ${fill(P, 'glow', ' opacity=".5"')}/>`
        + `<path d="M${x + 14},${y + 9} h30" stroke="#fff" stroke-opacity=".3" stroke-width="2" stroke-linecap="round"/></g>` };
    }
    case 'iris':
      return { front: `<g class="dr-eye">${roundBezel(32)}`
        + `<g class="dr-lid"><circle cx="${EX}" cy="${EY}" r="21" fill="url(#${P.id('iris')})" opacity=".95"/>`
        + `<circle cx="${EX}" cy="${EY}" r="21" ${stroke(P, 'glow', 6, ` opacity=".5" filter="url(#${P.id('glow')})"`)}/>`
        + (P.small ? '' : ticks(P, 10, 19))
        + `<circle cx="${EX}" cy="${EY}" r="8" fill="#0a0418"/><circle cx="${EX}" cy="${EY}" r="8" ${stroke(P, 'glow2', 1.4)}/></g>`
        + `<circle class="dr-scan" cx="${EX}" cy="${EY}" r="25" ${stroke(P, 'glow', 1.4, ' stroke-dasharray="14 120" stroke-linecap="round"')}/>`
        + `<circle cx="${EX - 7}" cy="${EY - 8}" r="3.2" fill="#fff" opacity=".8"/>${glint}</g>` };
  }
}

// ----- fins -------------------------------------------------------------------------------------------------
function fins(P: Ctx, k: DroneFins): Layers {
  const fg = `fill="url(#${P.id('fin')})" stroke="#000" stroke-opacity=".7" stroke-width="1.2"`;
  const edge = (d: string): string => `<path d="${d}" ${stroke(P, 'glow', 1.2, ' opacity=".55" stroke-linecap="round"')}/>`;
  const hubR = `<ellipse cx="196" cy="114" rx="11" ry="17" fill="url(#${P.id('bezel')})"/><ellipse cx="198" cy="114" rx="6" ry="11" fill="#05070c"/>`;
  const hubL = `<ellipse cx="61" cy="120" rx="7" ry="13" fill="url(#${P.id('bezel')})"/>`;
  let right = '', left = '', detail = '';
  switch (k) {
    case 'blade':
      right = 'M198,100 L240,80 Q248,77 247,86 L242,124 Q241,131 234,132 L200,134 Z';
      left = 'M62,104 L36,98 Q30,97 30,104 L32,138 Q33,145 39,144 L62,138 Z';
      detail = P.small ? '' : edge('M206,104 L238,90') + `<path d="M210,122 h14 l6,-8 h8" ${stroke(P, 'deep', 1.4, ' opacity=".9"')}/>`;
      break;
    case 'panel':
      right = 'M198,96 L244,84 Q250,83 250,89 L249,130 Q249,136 243,136 L198,136 Z';
      left = 'M62,100 L30,94 Q25,93 25,99 L26,140 Q26,146 32,146 L62,140 Z';
      detail = P.small ? '' : `<path d="M206,104 L242,95 V126 H206 Z" ${stroke(P, 'glow', 1, ' opacity=".5"')}/>` + glowLine(P, 'M212,120 h10 l6,-6 h10', 1, 'glow', 0.8);
      break;
    case 'quill': {
      right = 'M196,122 C206,92 226,62 254,38 C252,70 236,104 204,132 Z';
      left = 'M62,106 L40,102 Q35,101 35,107 L37,136 Q38,142 43,141 L62,136 Z';
      const barbs = P.small ? '' : [0, 1, 2, 3, 4, 5].map((i) => { const t = i / 6; const x = 204 + t * 40, y = 120 - t * 70; return `M${x.toFixed(0)},${y.toFixed(0)} l${(10 - t * 4).toFixed(0)},2`; }).join(' ');
      detail = `<path d="M200,128 C214,104 232,72 252,42" ${stroke(P, 'glow', 1.4, ' opacity=".8"')}/>` + (barbs ? `<path d="${barbs}" ${stroke(P, 'deep', 1, ' opacity=".8"')}/>` : '');
      break;
    }
    case 'wing':
      right = 'M198,104 L248,94 L240,108 L252,114 L242,124 L250,130 L200,134 Z';
      left = 'M62,106 L18,100 L26,112 L14,118 L26,126 L18,134 L62,138 Z';
      detail = P.small ? '' : `<path d="M206,112 L238,108 M206,124 L236,124" ${stroke(P, 'glow', 1, ' opacity=".45"')}/>`;
      break;
  }
  const bevel = (d: string): string => `<path d="${d}" fill="url(#${P.id('finshade')})"/><path d="${d}" fill="none" stroke="${P.c.hi}" class="dr-k-hi" stroke-width="1" stroke-opacity=".55"/>`;
  return { back: `<path d="${left}" ${fg}/>${bevel(left)}${hubL}` + `<path d="${right}" ${fg}/>${bevel(right)}${detail}`, front: hubR };
}

// ----- crystal --------------------------------------------------------------------------------------------
function crystal(P: Ctx, k: DroneCrystal): string {
  const top = P.small ? 200 : 212;
  const cab = P.small ? `M128,184 C128,190 132,192 131,196 C130,198 128,198 128,${top - 2}` : `M128,184 C128,194 134,198 132,206 C131,210 128,210 128,${top - 2}`;
  const cable = `<path d="${cab}" fill="none" stroke="#05070c" stroke-width="3" stroke-linecap="round"/>`
    + `<path d="${cab}" fill="none" stroke="#6a7488" stroke-width="1" stroke-opacity=".6"/>`
    + `<rect x="123" y="${top - 4}" width="10" height="5" rx="1.5" fill="url(#${P.id('bezel')})"/>`;
  const g = k === 'prism' ? `url(#${P.id('prism')})` : `url(#${P.id('gem')})`;
  let body = '';
  switch (k) {
    case 'gem': case 'prism':
      body = `<polygon points="128,${top} 140,${top + 12} 128,${top + 34} 116,${top + 12}" fill="${g}"/>`
        + `<polygon points="128,${top} 140,${top + 12} 128,${top + 15} 116,${top + 12}" fill="#fff" opacity=".35"/>`
        + `<polygon points="128,${top + 15} 140,${top + 12} 128,${top + 34}" fill="#000" opacity=".28"/>`; break;
    case 'drop':
      body = `<path d="M128,${top} C138,${top + 14} 140,${top + 22} 128,${top + 32} C116,${top + 22} 118,${top + 14} 128,${top} Z" fill="${g}"/>`
        + `<path d="M128,${top + 4} C132,${top + 12} 132,${top + 18} 126,${top + 22}" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="1.5"/>`; break;
    case 'shard':
      body = `<polygon points="128,${top} 134,${top + 8} 131,${top + 38} 123,${top + 10}" fill="${g}"/><polygon points="128,${top} 134,${top + 8} 128,${top + 12} 123,${top + 10}" fill="#fff" opacity=".4"/>`; break;
  }
  const glow = `<ellipse cx="128" cy="${top + 16}" rx="12" ry="16" ${fill(P, k === 'prism' ? 'glow' : 'glow2', ` opacity=".45" filter="url(#${P.id('glow')})"`)}/>`;
  return `<g class="dr-pendant">${cable}${glow}${body}</g>`;
}

// ----- accessories ------------------------------------------------------------------------------------------
function accessory(P: Ctx, k: DroneAccessory): Layers {
  const gold = `url(#${P.id('gold')})`;
  switch (k) {
    case 'tophat':
      return { front: `<g transform="rotate(-6 128 52)"><ellipse cx="128" cy="56" rx="42" ry="9" fill="#0b0b10" stroke="#3a3644" stroke-width="1.2"/>`
        + `<path d="M104,54 L106,16 Q128,10 150,16 L152,54 Q128,60 104,54 Z" fill="#111116" stroke="#34303c" stroke-width="1.2"/>`
        + `<path d="M105,44 Q128,49 151,44 L151.6,52 Q128,57 104.4,52 Z" fill="#2a2630"/><path d="M110,20 Q112,34 111,48" stroke="#fff" stroke-opacity=".12" stroke-width="3" fill="none"/>`
        + `<path d="M106,16 Q128,10 150,16" ${stroke(P, 'glow', 1, ' opacity=".4"')}/></g>` };
    case 'monocle-cracked': case 'monocle-magnifier': {
      const mx = 150, my = 126, r = 19;
      const crack = k === 'monocle-cracked' ? `<path d="M${mx - 12},${my - 6} l8,3 l3,-9 M${mx - 4},${my - 3} l4,8 l9,2 M${mx},${my + 5} l-6,9 M${mx + 9},${my + 7} l4,-10" fill="none" stroke="#e8e0c8" stroke-opacity=".7" stroke-width="0.9"/>` : '';
      const handle = k === 'monocle-magnifier'
        ? `<path d="M${mx + 12},${my + 15} l12,16" stroke="${gold}" stroke-width="5" stroke-linecap="round"/>`
        : `<path d="M${mx + r},${my + 2} C${mx + 26},${my + 24} ${mx + 18},${my + 40} ${mx + 24},${my + 54}" fill="none" stroke="#d8a84a" stroke-width="1.2" stroke-dasharray="2 1.6"/>`;
      return { front: `${handle}<circle cx="${mx}" cy="${my}" r="${r}" fill="#9ad8ff" opacity=".16"/>${crack}`
        + `<circle cx="${mx}" cy="${my}" r="${r}" fill="none" stroke="${gold}" stroke-width="${P.small ? 5 : 3.6}"/>`
        + `<path d="M${mx - 12},${my - 10} a15,15 0 0 1 12,-6" stroke="#fff" stroke-opacity=".6" stroke-width="1.6" fill="none"/>` };
    }
    case 'antenna':
      return { back: `<path d="M134,52 L140,16" stroke="#1a1f2a" stroke-width="3.4" stroke-linecap="round"/><path d="M134,52 L140,16" stroke="#8a94a8" stroke-width="1" />`
        + `<circle cx="141" cy="13" r="9" ${fill(P, 'glow', ` opacity=".6" filter="url(#${P.id('glow')})"`)}/><circle cx="141" cy="13" r="5.5" ${fill(P, 'glow2')}/><circle cx="139.5" cy="11.5" r="1.8" fill="#fff" opacity=".8"/>`
        + `<ellipse cx="134" cy="52" rx="7" ry="3" fill="url(#${P.id('bezel')})"/>` };
    case 'headphones':
      return { front: `<path d="M60,104 C52,18 204,18 196,104" fill="none" stroke="#14141c" stroke-width="9" stroke-linecap="round"/>`
          + `<path d="M60,104 C52,18 204,18 196,104" ${stroke(P, 'glow', 1.4, ' opacity=".6"')}/>` + [[62, 120], [194, 116]].map(([x, y]) => `<rect x="${x - 10}" y="${y - 20}" width="20" height="40" rx="9" fill="#17151e" stroke="#000" stroke-width="1"/>`
          + `<rect x="${x - 5}" y="${y - 14}" width="10" height="28" rx="5" ${fill(P, 'glow2', ' opacity=".9"')}/><rect x="${x - 5}" y="${y - 14}" width="10" height="28" rx="5" ${fill(P, 'glow', ` opacity=".5" filter="url(#${P.id('glow')})"`)}/>`).join('') };
    case 'quill':
      return { back: `<path d="M84,64 C70,40 60,22 52,6 C70,16 86,36 94,58 Z" fill="#f4f0ff" opacity=".92"/><path d="M90,62 C78,40 66,22 54,8" ${stroke(P, 'glow2', 1.2)}/>` };
    case 'compass': {
      let t = '';
      if (!P.small) for (let i = 0; i < 36; i++) { const a = (i / 36) * Math.PI * 2; t += `M${(CX + Math.cos(a) * 96).toFixed(1)},${(CY + Math.sin(a) * 20).toFixed(1)}L${(CX + Math.cos(a) * (i % 9 ? 90 : 84)).toFixed(1)},${(CY + Math.sin(a) * (i % 9 ? 18.5 : 17)).toFixed(1)}`; }
      const tr = `rotate(-18 ${CX} ${CY})`;
      const half = (b: boolean): string => `<g transform="${tr}"><path d="M${CX - 96},${CY} A96,20 0 0 ${b ? 1 : 0} ${CX + 96},${CY}" fill="none" stroke="${gold}" stroke-width="${P.small ? 4 : 3}"/>`
        + (b ? '' : `<path d="${t}" stroke="#ffe0a0" stroke-width="0.9" opacity=".7"/><circle cx="${CX + 96}" cy="${CY}" r="3.4" ${fill(P, 'glow')}/>`) + '</g>';
      return { back: half(true), front: half(false) };
    }
    case 'halo':
      return { back: `<ellipse cx="128" cy="38" rx="40" ry="9" ${stroke(P, 'glow', 10, ` opacity=".45" filter="url(#${P.id('glow')})"`)}/><ellipse cx="128" cy="38" rx="40" ry="9" ${stroke(P, 'glow', 3.2)}/><ellipse cx="128" cy="38" rx="40" ry="9" fill="none" stroke="#fff" stroke-width="1" opacity=".7"/>` };
    case 'crown': {
      const pts = [[100, 58, 92, 34], [128, 50, 128, 22], [156, 58, 164, 34]];
      return { back: pts.map(([x1, y1, x2, y2]) => `<path d="M${x1},${y1} L${x2},${y2}" stroke="#1a1f2a" stroke-width="4" stroke-linecap="round"/>`
        + `<circle cx="${x2}" cy="${y2}" r="8" ${fill(P, 'glow', ` opacity=".55" filter="url(#${P.id('glow')})"`)}/><circle cx="${x2}" cy="${y2}" r="4.5" ${fill(P, 'glow')}/><circle cx="${x2 - 1}" cy="${y2 - 1}" r="1.6" fill="#fff"/>`).join('') };
    }
    case 'hoop':
      return { back: `<g transform="translate(176 14)"><rect x="0" y="0" width="44" height="30" rx="3" fill="#e8eef8" opacity=".9"/><rect x="12" y="10" width="20" height="14" fill="none" stroke="#d0402a" stroke-width="2"/></g>`,
        front: `<g transform="translate(176 14)"><ellipse cx="22" cy="34" rx="15" ry="4" fill="none" stroke="#ff6a2a" stroke-width="3"/>`
          + `<path d="M8,35 L12,52 M15,37 L16,54 M22,38 L22,55 M29,37 L28,54 M36,35 L32,52 M11,44 Q22,50 33,44" fill="none" stroke="#f0f4ff" stroke-width="1.1" opacity=".85"/></g>` };
    case 'leaf':
      return { back: `<path d="M128,52 C128,40 126,32 124,24" stroke="#2a5a20" stroke-width="3" fill="none" stroke-linecap="round"/>`
        + `<path d="M125,30 C108,30 98,18 96,6 C112,6 124,14 125,30 Z" fill="#6ad04a"/><path d="M125,30 C140,26 150,14 152,2 C136,4 126,14 125,30 Z" fill="#9aee5a"/>`
        + `<path d="M125,30 C112,22 104,14 98,8 M126,28 C138,20 146,12 150,5" stroke="#1e4a14" stroke-width="1" fill="none"/>` };
    case 'flame':
      return { back: `<path d="M128,58 C100,52 104,30 116,16 C116,28 122,32 126,30 C122,18 130,6 140,0 C138,14 152,22 152,38 C152,50 142,58 128,58 Z" fill="#ff5a1e" filter="url(#${P.id('soft')})"/>`
        + `<path d="M128,58 C112,54 114,40 120,32 C122,40 128,42 130,38 C130,30 136,24 140,20 C140,30 146,36 146,44 C146,52 138,58 128,58 Z" fill="#ffc04a"/>`
        + `<path d="M128,58 C122,56 122,48 126,44 C128,48 132,48 134,46 C136,52 134,58 128,58 Z" fill="#fff6c0"/>` };
    case 'steam':
      return { back: [110, 128, 146].map((x, i) => `<path d="M${x},50 c-8,-8 8,-14 0,-22 c-8,-8 8,-12 0,-20" fill="none" stroke="#e8f0ff" stroke-width="${2.6 - i * 0.3}" stroke-linecap="round" opacity="${0.55 - i * 0.1}" filter="url(#${P.id('soft')})"/>`
        + `<path d="M${x},50 c-8,-8 8,-14 0,-22 c-8,-8 8,-12 0,-20" fill="none" stroke="#ffffff" stroke-width="1.2" stroke-linecap="round" opacity=".6"/>`).join('') };
    case 'chess-crown':
      return { back: `<path d="M110,56 L106,36 L118,44 L128,30 L138,44 L150,36 L146,56 Z" fill="${gold}" stroke="#3a2808" stroke-width="1"/>`
        + `<path d="M128,30 V12 M120,19 H136" stroke="${gold}" stroke-width="4.6" stroke-linecap="round"/><circle cx="128" cy="46" r="3" ${fill(P, 'glow')}/>` };
    case 'star':
      return { front: `<g transform="translate(206 44)"><circle r="12" ${fill(P, 'glow', ` opacity=".5" filter="url(#${P.id('glow')})"`)}/>`
        + `<path d="M0,-11 L3,-3 L11,0 L3,3 L0,11 L-3,3 L-11,0 L-3,-3 Z" fill="#fff"/></g>` };
  }
}

export interface ComposeOptions {
  /** 'full' (default) or 'small' (simplified optical variant for 32-44px). */
  detail?: 'full' | 'small';
  /** Pixel size written to width/height (omit for a scalable SVG). */
  size?: number;
  /** Extra uniqueness for gradient ids when several identical drones share a page. */
  uid?: string;
  /** Extra classes on the root svg. */
  className?: string;
  title?: string;
}

/** DroneSpec -> SVG markup. Deterministic: same spec + options -> same string. */
export function composeDrone(specIn: DroneSpec, opts: ComposeOptions = {}): string {
  const spec = sanitizeSpec(specIn);
  const small = opts.detail === 'small';
  const pre = `dr${hash32(specKey(spec) + (small ? 's' : 'f') + (opts.uid ?? '')).toString(36)}`;
  const P: Ctx = { id: (n) => `${pre}-${n}`, url: (n) => `url(#${pre}-${n})`, c: { ...DRONE_PALETTES[spec.palette] }, small };
  const parts: Layers[] = [shell(P, spec.shell), fins(P, spec.fins), eye(P, spec.eye)];
  const accs = small ? spec.accessories.slice(0, 2) : spec.accessories;
  const accL = accs.map((a) => accessory(P, a));
  // Layer order: aura, accessory backs, shell back (planet ring), fins, shell, eye, fin hubs, accessory fronts, shell front.
  const sh = parts[0], fi = parts[1], ey = parts[2];
  const body = [accL.map((l) => l.back ?? '').join(''), sh.back ?? '', fi.back ?? '', sh.mid ?? '', fi.front ?? '', ey.front ?? '',
    accL.map((l) => l.front ?? '').join(''), sh.front ?? ''].join('');
  const vb = small ? '20 8 222 228' : '0 0 256 256';
  const wh = opts.size ? ` width="${opts.size}" height="${opts.size}"` : '';
  const cls = ['drone', `dr-shell-${spec.shell}`, small ? 'dr-sm' : '', opts.className ?? ''].filter(Boolean).join(' ');
  const title = opts.title ? `<title>${opts.title.replace(/[<&>"]/g, '')}</title>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}"${wh} class="${cls}" role="img" focusable="false">${title}${defs(P)}`
    + `<circle class="dr-aura" cx="${CX}" cy="${CY}" r="118" fill="url(#${P.id('aura')})"/>`
    + `<g class="dr-float"><g class="dr-body">${body}</g>${crystal(P, spec.crystal)}</g></svg>`;
}
