// v1.22: the bot's write_file tool. Nothing is ever written without the user's confirm:
//   1. planWrite() checks the request against the Attach folder rules (relative path only, no "..", parent folder
//      resolved with realpath and still inside the folder, target not a symlink or a non-file, text only, size cap).
//   2. main shows a native dialog (dialog.showMessageBox) with the real resolved path and whether a file would be
//      replaced; Cancel is the default. Only on Write/Replace/Save-as-new does main issue a one-time token, bound to
//      the chat, the exact resolved path, the SHA-256 of the content and the mode, with a short expiry.
//   3. commitWrite() consumes that token first and refuses without it. It re-checks the folder rules, writes a temp
//      file in the same folder and renames it into place. It is the only function in the app that writes into a
//      bot's folder.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ToolError } from './readFileTool';

/** Largest file the bot may write (UTF-8 bytes). */
export const MAX_WRITE_BYTES = 200 * 1024;
/** A confirmed write must happen within this long. */
export const WRITE_TOKEN_TTL_MS = 60_000;
/** Text files only. */
export const WRITE_EXTENSIONS = ['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.yaml', '.yml', '.xml', '.log', '.ini', '.toml', '.html', '.css'];

export const WRITE_FILE_TOOL = {
  type: 'function',
  function: {
    name: 'write_file',
    description:
      'Write a text file into the folder the user shared with you. The user is always asked first and sees the full path; ' +
      'they may cancel. Pass a path relative to that folder, e.g. "notes/plan.md", and the full text content.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the shared folder (no absolute paths, no "..").' },
        content: { type: 'string', description: 'The complete text to write.' },
      },
      required: ['path', 'content'],
    },
  },
} as const;

export type WriteMode = 'new' | 'replace';

export interface WritePlan {
  /** Real (symlink-resolved) folder root. */
  root: string;
  /** Absolute target path: realpath(parent) + file name. */
  target: string;
  /** Path relative to the folder, for display. */
  relPath: string;
  /** A file is already at target. */
  exists: boolean;
  /** When it exists: a free "name (2).ext" alternative next to it. */
  alternative: string | null;
  bytes: number;
  hash: string;
}

export const contentHash = (content: string): string => crypto.createHash('sha256').update(content, 'utf8').digest('hex');

function inside(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel !== '' && !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep);
}

/** Validate the requested relative path (string rules only). Returns its normalized segments. */
export function checkRelPath(requested: unknown): string[] {
  if (typeof requested !== 'string' || !requested.trim()) throw new ToolError('A file path is required.');
  const p = requested.trim();
  if (p.includes('\0')) throw new ToolError('Invalid path.');
  if (path.isAbsolute(p) || path.win32.isAbsolute(p) || p.startsWith('~')) throw new ToolError('Use a path relative to the shared folder, not an absolute path.');
  const parts = p.split(/[\\/]+/).filter((s) => s !== '' && s !== '.');
  if (!parts.length) throw new ToolError('A file path is required.');
  if (parts.some((s) => s === '..')) throw new ToolError('Paths with ".." are not allowed.');
  const ext = path.extname(parts[parts.length - 1]).toLowerCase();
  if (!WRITE_EXTENSIONS.includes(ext)) throw new ToolError(`Only text files can be written (${WRITE_EXTENSIONS.join(', ')}).`);
  return parts;
}

/** Text only, within the size cap. */
export function checkContent(content: unknown): string {
  if (typeof content !== 'string') throw new ToolError('File content must be text.');
  if (content.includes('\0')) throw new ToolError('Only text can be written.');
  if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) throw new ToolError(`That file is larger than ${MAX_WRITE_BYTES / 1024} KB.`);
  return content;
}

async function lstatOrNull(p: string): Promise<import('node:fs').Stats | null> {
  try { return await fs.lstat(p); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}

/** Resolve a write request against the folder. Writes nothing. */
export async function planWrite(folder: string | null, requested: unknown, contentRaw: unknown): Promise<WritePlan> {
  if (!folder) throw new ToolError('No folder has been shared with this bot yet.');
  const parts = checkRelPath(requested);
  const content = checkContent(contentRaw);
  let root: string;
  try { root = await fs.realpath(folder); } catch { throw new ToolError('The shared folder no longer exists.'); }
  const name = parts[parts.length - 1];
  let parentReal: string;
  try { parentReal = await fs.realpath(path.join(root, ...parts.slice(0, -1))); } catch {
    throw new ToolError('That folder does not exist inside the shared folder (folders are not created).');
  }
  if (parentReal !== root && !inside(root, parentReal)) throw new ToolError('Access denied: path is outside the shared folder.');
  const target = path.join(parentReal, name);
  if (!inside(root, target)) throw new ToolError('Access denied: path is outside the shared folder.');
  const st = await lstatOrNull(target);
  if (st?.isSymbolicLink()) throw new ToolError('Refused: that path is a symbolic link.');
  if (st && !st.isFile()) throw new ToolError('Refused: that path is not a regular file.');
  return {
    root, target, relPath: path.relative(root, target), exists: !!st,
    alternative: st ? await freeName(target) : null,
    bytes: Buffer.byteLength(content, 'utf8'), hash: contentHash(content),
  };
}

/** "plan.md" → "plan (2).md", the first name not taken. */
export async function freeName(target: string): Promise<string> {
  const dir = path.dirname(target), ext = path.extname(target), base = path.basename(target, ext);
  for (let i = 2; i < 1000; i++) {
    const p = path.join(dir, `${base} (${i})${ext}`);
    if (!(await lstatOrNull(p))) return p;
  }
  throw new ToolError('Could not find a free file name.');
}

interface Grant { chatId: number; target: string; hash: string; mode: WriteMode; expiresAt: number }

/** One-time write tokens, bound to the chat, the exact resolved path, the content hash and the mode. */
export class WriteConsent {
  private grants = new Map<string, Grant>();
  constructor(private now: () => number = Date.now) {}
  issue(chatId: number, target: string, hash: string, mode: WriteMode): string {
    const token = crypto.randomBytes(24).toString('hex');
    this.grants.set(token, { chatId, target, hash, mode, expiresAt: this.now() + WRITE_TOKEN_TTL_MS });
    return token;
  }
  /** True once, for exactly what it was issued for, before expiry. Always removes the token. */
  consume(token: unknown, chatId: number, target: string, hash: string, mode: WriteMode): boolean {
    if (typeof token !== 'string') return false;
    const g = this.grants.get(token);
    this.grants.delete(token);
    return !!g && g.chatId === chatId && g.target === target && g.hash === hash && g.mode === mode && this.now() <= g.expiresAt;
  }
  revokeAll(): void { this.grants.clear(); }
  get size(): number { return this.grants.size; }
}

/**
 * The only write into a bot's folder. Refuses unless `token` is a live one-time grant for this chat, path, content
 * and mode. 'new' never replaces a file (fails if one appeared); 'replace' only replaces a regular file.
 */
export async function commitWrite(consent: WriteConsent, token: unknown, chatId: number, folder: string | null,
  target: string, content: string, mode: WriteMode): Promise<{ relPath: string; bytes: number }> {
  const hash = contentHash(content);
  if (!consent.consume(token, chatId, target, hash, mode)) throw new ToolError('Not written: the user did not confirm this exact file.');
  checkContent(content);
  if (!folder) throw new ToolError('No folder has been shared with this bot yet.');
  const root = await fs.realpath(folder);
  if (!inside(root, target) || (await fs.realpath(path.dirname(target))) !== path.dirname(target)) {
    throw new ToolError('Access denied: path is outside the shared folder.');
  }
  const st = await lstatOrNull(target);
  if (st?.isSymbolicLink() || (st && !st.isFile())) throw new ToolError('Refused: that path is not a regular file.');
  if (mode === 'new' && st) throw new ToolError('Not written: a file with that name appeared. Ask again.');
  if (mode === 'replace' && !st) throw new ToolError('Not written: the file to replace is gone. Ask again.');
  const tmp = path.join(path.dirname(target), `.cipher-write-${crypto.randomBytes(6).toString('hex')}.tmp`);
  const fh = await fs.open(tmp, 'wx', 0o644);
  try {
    await fh.writeFile(content, 'utf8');
    await fh.sync();
  } finally { await fh.close(); }
  try {
    if (mode === 'new') {
      // link() fails if the name was taken meanwhile, so a new file never replaces anything.
      await fs.link(tmp, target);
      await fs.unlink(tmp);
    } else {
      await fs.rename(tmp, target);
    }
  } catch (e) {
    await fs.rm(tmp, { force: true });
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new ToolError('Not written: a file with that name appeared. Ask again.');
    throw e;
  }
  return { relPath: path.relative(root, target), bytes: Buffer.byteLength(content, 'utf8') };
}

/** Text for the native confirm dialog (main shows it; the renderer never can). */
export function writeDialogText(botName: string, plan: WritePlan, content: string): { message: string; detail: string; buttons: string[] } {
  const preview = content.length > 600 ? `${content.slice(0, 600)}\n…` : content;
  const size = plan.bytes < 1024 ? `${plan.bytes} bytes` : `${(plan.bytes / 1024).toFixed(1)} KB`;
  if (plan.exists) {
    return {
      message: `${botName} wants to REPLACE an existing file.`,
      detail: `${plan.target}\n\nThis file already exists and would be replaced (${size}). Or save as a new file:\n${plan.alternative}\n\nContent:\n${preview}`,
      buttons: ['Cancel', 'Replace file', 'Save as new name'],
    };
  }
  return {
    message: `${botName} wants to write a new file.`,
    detail: `${plan.target}\n\nNew file, ${size}. Nothing is replaced.\n\nContent:\n${preview}`,
    buttons: ['Cancel', 'Write file'],
  };
}

export interface ConfirmDeps {
  consent: WriteConsent;
  /** Refuse while Cipher Bot is locked (checked before asking and again after the answer). */
  isLocked: () => boolean;
  /** Main's native dialog; resolves to the button index (0 = Cancel). */
  ask: (text: { message: string; detail: string; buttons: string[] }) => Promise<number>;
}

/**
 * The whole write_file flow for one tool call: plan → native confirm → one-time token → commitWrite.
 * Returns the text the bot sees. Nothing is written unless the user pressed Write/Replace/Save as new name.
 */
export async function confirmAndWrite(d: ConfirmDeps, chatId: number, botName: string, folder: string | null,
  requested: unknown, content: unknown): Promise<{ ok: boolean; path: string; content: string }> {
  const shown = typeof requested === 'string' ? requested : '';
  try {
    if (d.isLocked()) throw new ToolError('Cipher Bot is locked.');
    const plan = await planWrite(folder, requested, content);
    const text = writeDialogText(botName, plan, content as string);
    const answer = await d.ask(text);
    if (d.isLocked()) throw new ToolError('Cipher Bot is locked.');
    let target = plan.target, mode: WriteMode = 'new';
    if (plan.exists && answer === 1) mode = 'replace';
    else if (plan.exists && answer === 2 && plan.alternative) target = plan.alternative;
    else if (!(plan.exists === false && answer === 1)) {
      return { ok: false, path: plan.relPath, content: 'The user cancelled: no file was written. Do not try again unless they ask.' };
    }
    const token = d.consent.issue(chatId, target, plan.hash, mode);
    const r = await commitWrite(d.consent, token, chatId, folder, target, content as string, mode);
    return { ok: true, path: r.relPath, content: `Wrote ${r.relPath} (${r.bytes} bytes)${mode === 'replace' ? ', replacing the old file' : ''}.` };
  } catch (e) {
    return { ok: false, path: shown, content: `Error: ${e instanceof Error ? e.message : String(e)}` };
  }
}
