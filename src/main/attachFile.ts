/**
 * User file attach for 1:1 chat (v1.7). Not a new tool — reads text through the same
 * folder sandbox as read_file (resolveInsideFolder / readFileInFolder), then formats
 * contents into the outgoing user message.
 */
import path from 'node:path';
import { readFileInFolder, ToolError } from './readFileTool';

export interface AttachResult {
  relPath: string;
  content: string;
  /** Ready-to-append block for the user message. */
  block: string;
}

/** Format attached file text with a clear filename header for the model. */
export function formatAttachBlock(relPath: string, content: string): string {
  const name = relPath.replace(/\\/g, '/');
  return `--- Attached file: ${name} ---\n${content}\n--- End of attached file: ${name} ---`;
}

/**
 * Read a file for attach. `requested` may be a path relative to the bot folder or an
 * absolute path under it (as returned by the native file dialog). Uses the same sandbox
 * as read_file: no `..` escape, no symlink escape, size + UTF-8 text caps.
 */
export async function readFileForAttach(folderPath: string | null, requested: unknown): Promise<AttachResult> {
  if (!folderPath) throw new ToolError('Choose a folder for this Cipher bot before attaching a file.');
  const r = await readFileInFolder(folderPath, requested);
  return { relPath: r.relPath, content: r.content, block: formatAttachBlock(r.relPath, r.content) };
}

/** Merge optional typed text with an attach block for one user turn. */
export function mergeAttachIntoMessage(typed: string, block: string | null): string {
  const t = typed.trim();
  if (!block) return t;
  if (!t) return block;
  return `${t}\n\n${block}`;
}

/** Basename for UI chip display. */
export function attachDisplayName(relPath: string): string {
  return path.basename(relPath.replace(/\\/g, '/'));
}
