// Export the open chat (a bot's 1:1 chat or a room) as plain text. Pure formatting only; main.ts shows the
// native Save dialog and writes the file locally. No network.
import type { Bot, Message, RoomMessage } from '../shared/types';

export interface ExportLine {
  /** ISO timestamp from the database. */
  createdAt: string;
  speaker: string;
  text: string;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Local date and time as "YYYY-MM-DD HH:MM" (the computer's time zone). Invalid input comes back unchanged. */
export function exportTime(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * The export text: a header (bot or room name, export date), a blank line, then one `[time] Speaker: text` line
 * per message. Continuation lines of a multi-line message are indented so each message starts on its own line.
 */
export function formatChatExport(opts: { kind: 'bot' | 'room'; name: string; exportedAt: Date; lines: readonly ExportLine[] }): string {
  const out = [
    'Cipher chat export',
    opts.kind === 'room' ? `Room: ${opts.name}` : `Cipher bot: ${opts.name}`,
    `Exported: ${exportTime(opts.exportedAt)}`,
    '',
  ];
  if (!opts.lines.length) out.push('(No messages)');
  for (const l of opts.lines) {
    const text = l.text.replace(/\r\n?/g, '\n').replace(/\n/g, '\n    ');
    out.push(`[${exportTime(l.createdAt)}] ${l.speaker}: ${text}`);
  }
  return out.join('\n') + '\n';
}

/** A 1:1 chat's lines: the user's messages ("You") and the bot's replies. File-reading steps are left out. */
export function botChatExportLines(bot: Pick<Bot, 'name'>, messages: readonly Message[]): ExportLine[] {
  const lines: ExportLine[] = [];
  for (const m of messages) {
    if (m.role === 'tool' || !m.content) continue;
    lines.push({ createdAt: m.createdAt, speaker: m.role === 'user' ? 'You' : bot.name, text: m.content });
  }
  return lines;
}

/** A room's lines: the user's messages ("You") and each bot's reply under that bot's name. */
export function roomExportLines(messages: readonly RoomMessage[], botName: (botId: number | null) => string | null): ExportLine[] {
  return messages
    .filter((m) => m.content)
    .map((m) => ({ createdAt: m.createdAt, speaker: m.role === 'user' ? 'You' : botName(m.botId) ?? 'Cipher bot', text: m.content }));
}

/** Default file name for the Save dialog: `<name>-chat.txt`, without characters file systems reject. */
export function exportFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const safe = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 80).trim();
  return `${safe || 'cipher'}-chat.txt`;
}
