import fs from 'node:fs/promises';
import path from 'node:path';
import type { ToolCall } from '../shared/types';

/** Largest file the tool will return to the model. */
export const MAX_FILE_BYTES = 256 * 1024;

/** Tool definition in Ollama's /api/chat `tools` format. */
export const READ_FILE_TOOL = {
  type: 'function',
  function: {
    name: 'read_file',
    description:
      'Read a UTF-8 text file from the folder the user shared with you. ' +
      'Pass a path relative to that folder, for example "notes.txt" or "docs/plan.md".',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the shared folder.' },
      },
      required: ['path'],
    },
  },
} as const;

export class ToolError extends Error {}

function isInside(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false; // e.g. a different drive on Windows
  return rel !== '..' && !rel.startsWith('..' + path.sep);
}

/**
 * Resolve `requested` against the shared folder `root` and return the real path of the target.
 * Resolves `..` and symlinks (on both the root and the target) and rejects anything that ends up
 * outside the root.
 */
export async function resolveInsideFolder(root: string | null, requested: unknown): Promise<string> {
  if (!root) throw new ToolError('No folder has been shared with this bot yet.');
  if (typeof requested !== 'string' || requested.trim() === '') throw new ToolError('A file path is required.');
  if (requested.includes('\0')) throw new ToolError('Invalid path.');

  let rootReal: string;
  try {
    rootReal = await fs.realpath(root);
  } catch {
    throw new ToolError('The shared folder no longer exists.');
  }

  const candidate = path.resolve(rootReal, requested.trim());
  if (!isInside(rootReal, candidate)) throw new ToolError('Access denied: path is outside the shared folder.');

  let real: string;
  try {
    real = await fs.realpath(candidate);
  } catch {
    throw new ToolError(`File not found: ${requested}`);
  }
  if (!isInside(rootReal, real)) throw new ToolError('Access denied: path is outside the shared folder.');
  return real;
}

export interface ReadResult {
  /** Path relative to the shared folder (for display). */
  relPath: string;
  content: string;
}

/** Read a text file inside the shared folder, enforcing the sandbox, size cap and text-only rule. */
export async function readFileInFolder(root: string | null, requested: unknown): Promise<ReadResult> {
  const real = await resolveInsideFolder(root, requested);
  const rootReal = await fs.realpath(root!);
  // Check the type before opening so FIFOs/devices can't block or be read.
  if (!(await fs.stat(real)).isFile()) throw new ToolError('Not a regular file.');
  const fh = await fs.open(real, 'r');
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new ToolError('Not a regular file.');
    if (st.size > MAX_FILE_BYTES) {
      throw new ToolError(`File is too large (${st.size} bytes). The limit is ${MAX_FILE_BYTES} bytes.`);
    }
    // Read at most limit+1 bytes so a file that grows after stat() is still capped.
    const buf = Buffer.alloc(MAX_FILE_BYTES + 1);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    if (bytesRead > MAX_FILE_BYTES) throw new ToolError(`File is too large. The limit is ${MAX_FILE_BYTES} bytes.`);
    const data = buf.subarray(0, bytesRead);
    if (data.includes(0)) throw new ToolError('This looks like a binary file; only text files can be read.');
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(data);
    } catch {
      throw new ToolError('This file is not valid UTF-8 text; only text files can be read.');
    }
    return { relPath: path.relative(rootReal, real) || path.basename(real), content };
  } finally {
    await fh.close();
  }
}

export interface ToolOutcome {
  name: string;
  path: string;
  ok: boolean;
  /** Text fed back to the model as the tool message content. */
  content: string;
}

/** Execute a single tool call requested by the model. Never throws. */
export async function executeToolCall(call: ToolCall, folder: string | null): Promise<ToolOutcome> {
  const name = call?.function?.name ?? '';
  let args: unknown = call?.function?.arguments ?? {};
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { args = {}; }
  }
  const requested = (args as { path?: unknown })?.path;
  const shownPath = typeof requested === 'string' ? requested : '';
  if (name !== 'read_file') {
    return { name, path: shownPath, ok: false, content: `Error: unknown tool "${name}". The only available tool is read_file.` };
  }
  try {
    const r = await readFileInFolder(folder, requested);
    return { name, path: r.relPath, ok: true, content: r.content };
  } catch (e) {
    const msg = e instanceof ToolError ? e.message : 'Could not read the file.';
    return { name, path: shownPath, ok: false, content: `Error: ${msg}` };
  }
}
