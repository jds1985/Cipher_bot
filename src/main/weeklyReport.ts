// v1.25: a weekly report, made on this computer from cipher.db counts only (never chat text, names of files or search
// words). It is shown in the window and saved only if the user picks a file in a Save dialog.
export interface WeeklyCounts {
  since: string; until: string;
  bots: { name: string; sent: number; replies: number }[];
  rooms: { name: string; messages: number }[];
  tools: { tool: string; uses: number }[];
  backups: { scheduled: string; last: string | null; inFolder: number | null };
}

const TOOL_NAMES: Record<string, string> = {
  read_file: 'Read file', web_search: 'Web search', calculator: 'Calculator', checklist_add: 'Checklist', write_file: 'Write file', draft_file: 'Draft file',
};

export const weekStart = (now: Date): Date => new Date(now.getTime() - 7 * 86_400_000);

export function formatWeeklyReport(c: WeeklyCounts): string {
  const day = (iso: string) => iso.slice(0, 10);
  const lines = [`Cipher Bot weekly report: ${day(c.since)} to ${day(c.until)}`, '', 'Chats'];
  const active = c.bots.filter((b) => b.sent || b.replies);
  if (!active.length) lines.push('  No chats this week.');
  for (const b of active) lines.push(`  ${b.name}: ${b.sent} sent, ${b.replies} replies`);
  for (const r of c.rooms.filter((x) => x.messages)) lines.push(`  Room ${r.name}: ${r.messages} messages`);
  lines.push('', 'Tools used');
  if (!c.tools.length) lines.push('  None.');
  for (const t of c.tools) lines.push(`  ${TOOL_NAMES[t.tool] ?? 'Other'}: ${t.uses}`);
  lines.push('', 'Backups', `  Schedule: ${c.backups.scheduled}`, `  Last scheduled backup: ${c.backups.last ? day(c.backups.last) : 'none'}`);
  if (c.backups.inFolder !== null) lines.push(`  Backup files in the chosen folder: ${c.backups.inFolder}`);
  lines.push('', 'Counts only. Made on this computer; nothing was sent anywhere.');
  return `${lines.join('\n')}\n`;
}
