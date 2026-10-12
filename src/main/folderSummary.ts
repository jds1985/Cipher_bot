// v1.24: "Summarize folder". Main asks first (native dialog, Cancel default), then issues a one-time token for this
// chat + folder; only consuming that token gathers the text. Needs the bot's Files switch (checked when asked and again
// before reading). Text files, PDFs and .docx in the bot's own folder (top level only), with the read_file caps.
import fs from 'node:fs/promises';
import path from 'node:path';
import type { SearchConsent } from './searchConsent';
import { readFileInFolder } from './readFileTool';

export const SUMMARY_MAX_FILES = 20;
export const SUMMARY_MAX_CHARS = 60_000;
const READABLE = /\.(txt|md|markdown|csv|json|log|ini|yaml|yml|xml|html?|pdf|docx)$/i;

export async function listSummarizable(folder: string): Promise<string[]> {
  const ents = await fs.readdir(folder, { withFileTypes: true });
  return ents.filter((e) => e.isFile() && READABLE.test(e.name)).map((e) => e.name).sort().slice(0, SUMMARY_MAX_FILES);
}

export async function gatherFolderText(folder: string, names: string[]): Promise<{ text: string; used: string[] }> {
  let text = '';
  const used: string[] = [];
  for (const n of names) {
    if (text.length >= SUMMARY_MAX_CHARS) break;
    try {
      const r = await readFileInFolder(folder, n);
      const block = `--- ${r.relPath} ---\n${r.content.slice(0, SUMMARY_MAX_CHARS - text.length)}\n\n`;
      text += block;
      used.push(r.relPath);
    } catch { /* skip unreadable files */ }
  }
  return { text: text.trim(), used };
}

export interface SummaryDeps {
  consent: SearchConsent;
  isLocked: () => boolean;
  ask: (t: { message: string; detail: string; buttons: string[] }) => Promise<number>;
  /** Re-read the bot (the Files switch is checked again right before reading). */
  bot: () => { name: string; folderPath: string | null; filesOn: boolean } | null;
}

/** Ask, then read. Returns the user message to send, or null when cancelled. Throws on refusal. */
export async function confirmFolderSummary(d: SummaryDeps, chatId: number): Promise<string | null> {
  const b = d.bot();
  if (!b) throw new Error('Cipher bot not found.');
  if (!b.filesOn) throw new Error('Turn on Files for this Cipher bot (plus menu → Tools) to summarize its folder.');
  if (!b.folderPath) throw new Error('Choose a folder for this Cipher bot first.');
  if (d.isLocked()) throw new Error('Cipher Bot is locked.');
  const names = await listSummarizable(b.folderPath);
  if (!names.length) throw new Error('No readable files at the top of this folder.');
  const answer = await d.ask({
    message: `Let ${b.name} read ${names.length} file${names.length === 1 ? '' : 's'} and summarize the folder?`,
    detail: `${b.folderPath}\n\n${names.join('\n')}\n\nThe text goes to the model on this computer and is saved in this chat.`,
    buttons: ['Cancel', 'Summarize'],
  });
  if (answer !== 1 || d.isLocked()) return null;
  const key = `summary:${b.folderPath}`;
  const token = d.consent.issue(chatId, key);
  if (!d.consent.consume(token, chatId, key)) throw new Error('The confirmation expired.');
  const again = d.bot();
  if (!again?.filesOn || again.folderPath !== b.folderPath) throw new Error('Files was turned off; nothing was read.');
  const { text, used } = await gatherFolderText(b.folderPath, names);
  if (!text) throw new Error('None of those files could be read.');
  return `Summarize the files in my folder (${used.length}: ${used.join(', ')}).\n\n${text}`;
}

export const isInside = (root: string, p: string): boolean => !path.relative(root, p).startsWith('..');
