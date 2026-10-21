// Theme-from-prompt: a local, offline keyword/synonym mapper from a word or short prompt to a DroneSpec.
// No network, no image generation. Unknown words get a deterministic hashed spec.
// The chooser interface (DroneThemeChooser) is what a local LLM (Cipher) could implement later: it receives the
// prompt and the parts catalog (DRONE_LIBRARY) and returns JSON, which sanitizeSpec() turns into a valid spec.
import {
  DRONE_ACCESSORIES, DRONE_CRYSTALS, DRONE_EYES, DRONE_FINS, DRONE_LIBRARY, DRONE_PALETTE_KEYS, DRONE_SHELLS,
  hash32, sanitizeSpec, type DroneSpec,
} from './droneParts.js';

export interface DroneThemeResult { spec: DroneSpec; theme: string; source: 'keyword' | 'hash' | 'llm'; matched: string[]; }
/** Pluggable chooser: keyword mapper today; a local LLM later (may be async). */
export type DroneThemeChooser = (prompt: string, library: typeof DRONE_LIBRARY) => DroneThemeResult | Promise<DroneThemeResult>;

interface Theme { name: string; words: string[]; spec: Partial<DroneSpec>; }

export const DRONE_THEMES: Theme[] = [
  { name: 'basketball', words: ['basketball', 'hoop', 'nba', 'dunk', 'court', 'baller', 'ball', 'sport', 'sports'], spec: { shell: 'basketball', palette: 'orange', eye: 'ring', fins: 'blade', crystal: 'gem', accessories: ['hoop'] } },
  { name: 'music', words: ['music', 'musician', 'song', 'songs', 'dj', 'beat', 'beats', 'band', 'guitar', 'piano', 'sing', 'singer', 'audio', 'podcast', 'playlist', 'rap', 'jazz'], spec: { shell: 'striped', palette: 'magenta', eye: 'ring', fins: 'blade', crystal: 'gem', accessories: ['headphones'] } },
  { name: 'space', words: ['space', 'planet', 'galaxy', 'star', 'stars', 'astronomy', 'cosmos', 'rocket', 'orbit', 'nasa', 'moon', 'mars', 'astro'], spec: { shell: 'ringed', palette: 'violet', eye: 'ring', fins: 'wing', crystal: 'shard', accessories: ['star'] } },
  { name: 'detective', words: ['detective', 'mystery', 'sleuth', 'clue', 'clues', 'investigate', 'investigator', 'sherlock', 'noir', 'case', 'research', 'researcher', 'study'], spec: { shell: 'plain', palette: 'steel', eye: 'ring', fins: 'panel', crystal: 'drop', accessories: ['tophat', 'monocle-magnifier'] } },
  { name: 'gardening', words: ['garden', 'gardening', 'plant', 'plants', 'grow', 'flower', 'flowers', 'farm', 'nature', 'leaf', 'botany', 'green', 'tree'], spec: { shell: 'plain', palette: 'forest', eye: 'ring', fins: 'wing', crystal: 'drop', accessories: ['leaf'] } },
  { name: 'fire', words: ['fire', 'flame', 'flames', 'hot', 'burn', 'lava', 'volcano', 'blaze', 'spicy', 'dragon'], spec: { shell: 'cracked', palette: 'ember', eye: 'iris', fins: 'wing', crystal: 'shard', accessories: ['flame'] } },
  { name: 'ocean', words: ['ocean', 'sea', 'water', 'wave', 'waves', 'surf', 'beach', 'fish', 'fishing', 'dive', 'diving', 'sail', 'boat', 'marine'], spec: { shell: 'glass', palette: 'ocean', eye: 'ring', fins: 'wing', crystal: 'drop', accessories: [] } },
  { name: 'coding', words: ['code', 'coding', 'coder', 'program', 'programming', 'developer', 'dev', 'software', 'hack', 'hacker', 'debug', 'python', 'javascript', 'typescript', 'computer'], spec: { shell: 'plain', palette: 'lime', eye: 'visor', fins: 'blade', crystal: 'gem', accessories: [] } },
  { name: 'chess', words: ['chess', 'checkmate', 'king', 'queen', 'strategy', 'strategic', 'gambit', 'board', 'boardgame'], spec: { shell: 'armored', palette: 'obsidian', eye: 'hex', fins: 'panel', crystal: 'prism', accessories: ['chess-crown'] } },
  { name: 'coffee', words: ['coffee', 'espresso', 'latte', 'cafe', 'barista', 'tea', 'brew', 'mocha', 'cappuccino', 'morning'], spec: { shell: 'plain', palette: 'coffee', eye: 'ring', fins: 'panel', crystal: 'drop', accessories: ['steam'] } },
  { name: 'writing', words: ['write', 'writer', 'writing', 'poem', 'poetry', 'story', 'novel', 'author', 'journal', 'blog', 'essay', 'book', 'books'], spec: { shell: 'plain', palette: 'violet', eye: 'ring', fins: 'quill', crystal: 'gem', accessories: ['quill'] } },
  { name: 'planning', words: ['plan', 'planner', 'planning', 'schedule', 'calendar', 'travel', 'trip', 'map', 'navigate', 'compass', 'explore', 'adventure', 'hike', 'hiking'], spec: { shell: 'armored', palette: 'bronze', eye: 'ring', fins: 'panel', crystal: 'gem', accessories: ['compass'] } },
  { name: 'scout', words: ['scout', 'news', 'search', 'radar', 'signal', 'watch', 'alert', 'monitor', 'spy'], spec: { shell: 'plain', palette: 'coral', eye: 'ring', fins: 'blade', crystal: 'gem', accessories: ['antenna'] } },
  { name: 'angel', words: ['angel', 'heaven', 'kind', 'kindness', 'calm', 'meditation', 'meditate', 'zen', 'yoga', 'peace', 'wellness', 'health', 'therapy'], spec: { shell: 'glass', palette: 'ice', eye: 'ring', fins: 'wing', crystal: 'drop', accessories: ['halo'] } },
  { name: 'royal', words: ['royal', 'crown', 'boss', 'leader', 'ceo', 'manager', 'money', 'finance', 'gold', 'rich', 'invest', 'investing', 'business'], spec: { shell: 'armored', palette: 'gold', eye: 'hex', fins: 'panel', crystal: 'prism', accessories: ['crown'] } },
  { name: 'winter', words: ['winter', 'snow', 'ice', 'frost', 'cold', 'ski', 'skiing', 'arctic'], spec: { shell: 'glass', palette: 'ice', eye: 'hex', fins: 'blade', crystal: 'shard', accessories: [] } },
  { name: 'gentleman', words: ['gentleman', 'fancy', 'classy', 'magic', 'magician', 'error', 'glitch', 'bug', 'chaos', 'villain'], spec: { shell: 'cracked', palette: 'obsidian', eye: 'iris', fins: 'wing', crystal: 'prism', accessories: ['tophat', 'monocle-cracked'] } },
  { name: 'cipher', words: ['cipher', 'crypto', 'security', 'secure', 'privacy', 'encrypt', 'encryption', 'circuit', 'tech', 'ai', 'robot'], spec: { shell: 'circuit', palette: 'cipher', eye: 'hex', fins: 'panel', crystal: 'gem', accessories: [] } },
];

/** Lowercase words; light stemming (plurals, -ing) so 'flowers', 'gardening' still hit. */
export function tokenize(prompt: string): string[] {
  const raw = String(prompt ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (const w of raw) { out.push(w); if (w.length > 4 && w.endsWith('s')) out.push(w.slice(0, -1)); if (w.length > 5 && w.endsWith('ing')) out.push(w.slice(0, -3)); }
  return out;
}

/** Deterministic spec from a hash of the prompt (used for unknown words). */
export function hashedSpec(prompt: string): DroneSpec {
  const h = hash32(String(prompt ?? '').trim().toLowerCase() || 'cipher');
  const at = <T>(list: readonly T[], shift: number): T => list[(h >>> shift) % list.length];
  const accN = (h >>> 27) % 3; // 0, 1 (two in three) accessories
  const accessories = accN === 0 ? [] : [at(DRONE_ACCESSORIES, 21)];
  return sanitizeSpec({ shell: at(DRONE_SHELLS, 0), palette: at(DRONE_PALETTE_KEYS, 4), eye: at(DRONE_EYES, 9), fins: at(DRONE_FINS, 12), crystal: at(DRONE_CRYSTALS, 15), accessories });
}

/** The offline keyword chooser. Scores each theme by matched words; earliest word in the prompt wins ties. */
export const keywordChooser: DroneThemeChooser = (prompt) => {
  const toks = tokenize(prompt);
  let best: { t: Theme; score: number; first: number; matched: string[] } | null = null;
  for (const t of DRONE_THEMES) {
    const matched = toks.filter((w) => t.words.includes(w));
    if (!matched.length) continue;
    const first = toks.findIndex((w) => t.words.includes(w));
    const score = new Set(matched).size;
    if (!best || score > best.score || (score === best.score && first < best.first)) best = { t, score, first, matched: [...new Set(matched)] };
  }
  if (best) return { spec: sanitizeSpec(best.t.spec), theme: best.t.name, source: 'keyword', matched: best.matched };
  return { spec: hashedSpec(prompt), theme: 'hashed', source: 'hash', matched: [] };
};

/** Map a word/prompt to a drone. Synchronous offline path. */
export function themeDrone(prompt: string): DroneThemeResult { return keywordChooser(prompt, DRONE_LIBRARY) as DroneThemeResult; }

/** Prompt text a local LLM could be given to pick parts; its JSON answer goes through sanitizeSpec. */
export function llmPartPrompt(prompt: string): string {
  return `Design a drone avatar for: "${prompt.slice(0, 200)}". Choose ONLY ids from this catalog and answer with JSON `
    + `{"shell","palette","eye","fins","crystal","accessories":[up to 3]}.\n${JSON.stringify(DRONE_LIBRARY)}`;
}
