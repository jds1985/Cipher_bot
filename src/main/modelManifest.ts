import fs from 'node:fs';
import path from 'node:path';

/**
 * The one model Cipher Bot runs: Jim's own Cipher 2.0, described by resources/model/manifest.json and served by
 * the bundled cipher-serve. Swapping models (e.g. the 135M stand-in → the 369M) means swapping the .ctern file and
 * this manifest; no code changes. Only PUBLIC builds may ship: the private dev build is refused here and at bundle time.
 */
export interface ModelManifest {
  id: string;
  name: string;
  file: string;
  bytes: number;
  sha256: string;
  build: 'public';
  nCtx: number;
  vocab: number;
  maxReplyTokens: number;
  sampling: { temperature: number; topP: number; repetitionPenalty: number };
  systemPrompt: string;
  capabilities: { toolCalling: boolean };
}

/** True for anything that looks like the private dev build (manifest field, id or file name). */
export function looksLikeDevBuild(m: { build?: unknown; id?: unknown; file?: unknown }): boolean {
  if (m.build !== 'public') return true;
  return [m.id, m.file].some((v) => typeof v === 'string' && /(^|[^a-z])(dev|private)([^a-z]|$)/i.test(v));
}

/** Validate a parsed manifest. Throws a plain Error describing the first problem. */
export function parseManifest(raw: unknown): ModelManifest {
  const m = raw as Partial<ModelManifest> | null;
  if (!m || typeof m !== 'object') throw new Error('model manifest is not an object');
  for (const k of ['id', 'name', 'file', 'sha256', 'systemPrompt'] as const) {
    if (typeof m[k] !== 'string' || !m[k]) throw new Error(`model manifest: ${k} missing`);
  }
  for (const k of ['bytes', 'nCtx', 'vocab', 'maxReplyTokens'] as const) {
    if (typeof m[k] !== 'number' || !(m[k]! > 0)) throw new Error(`model manifest: ${k} missing`);
  }
  if (looksLikeDevBuild(m)) throw new Error('model manifest: only the public Cipher build may ship');
  if (path.basename(m.file!) !== m.file || !m.file!.endsWith('.ctern')) throw new Error('model manifest: file must be a bare .ctern name');
  if (m.maxReplyTokens! >= m.nCtx!) throw new Error('model manifest: maxReplyTokens must be below nCtx');
  return {
    ...(m as ModelManifest),
    sampling: { temperature: 0.7, topP: 0.9, repetitionPenalty: 1.2, ...(m.sampling ?? {}) },
    capabilities: { toolCalling: m.capabilities?.toolCalling === true },
  };
}

export function loadManifest(modelDir: string): ModelManifest {
  return parseManifest(JSON.parse(fs.readFileSync(path.join(modelDir, 'manifest.json'), 'utf8')));
}

/** Used only until the manifest is read (or if it can't be): the 135M stand-in's values, no tools. */
export const FALLBACK_MODEL: Pick<ModelManifest, 'id' | 'nCtx' | 'maxReplyTokens' | 'sampling' | 'systemPrompt' | 'capabilities'> = {
  id: 'cipher', nCtx: 1024, maxReplyTokens: 300, systemPrompt: 'You are Cipher, a helpful AI assistant.',
  sampling: { temperature: 0.7, topP: 0.9, repetitionPenalty: 1.2 }, capabilities: { toolCalling: false },
};
