import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { botChatExportLines, exportFileName, exportTime, formatChatExport, roomExportLines } from '../main/exportChat';
import type { Message, RoomMessage } from '../shared/types';

// Local times, so the expected strings hold in any time zone.
const at = (h: number, m: number) => new Date(2026, 9, 7, h, m, 30).toISOString();

test('exportTime is local "YYYY-MM-DD HH:MM"; bad input passes through', () => {
  assert.equal(exportTime(at(9, 5)), '2026-10-07 09:05');
  assert.equal(exportTime(new Date(2026, 0, 2, 23, 59)), '2026-01-02 23:59');
  assert.equal(exportTime('not a date'), 'not a date');
});

test('1:1 export: header with bot name and export date, then [time] Speaker: text; tool steps left out', () => {
  const msgs: Message[] = [
    { id: 1, chatId: 1, role: 'user', content: 'What is in notes.txt?', toolCalls: null, toolName: null, createdAt: at(9, 0), routine: false },
    { id: 2, chatId: 1, role: 'assistant', content: '', toolCalls: [{ function: { name: 'read_file', arguments: { path: 'notes.txt' } } }], toolName: null, createdAt: at(9, 0), routine: false },
    { id: 3, chatId: 1, role: 'tool', content: 'secret file text', toolCalls: null, toolName: 'read_file', createdAt: at(9, 1), routine: false },
    { id: 4, chatId: 1, role: 'assistant', content: 'It says:\r\nhello\nworld', toolCalls: null, toolName: null, createdAt: at(9, 2), routine: false },
    { id: 5, chatId: 1, role: 'user', content: 'Daily plan?', toolCalls: null, toolName: null, createdAt: at(9, 3), routine: true },
  ];
  const text = formatChatExport({ kind: 'bot', name: 'Planner', exportedAt: new Date(2026, 9, 7, 10, 30), lines: botChatExportLines({ name: 'Planner' }, msgs) });
  assert.equal(text, [
    'Cipher chat export',
    'Cipher bot: Planner',
    'Exported: 2026-10-07 10:30',
    '',
    '[2026-10-07 09:00] You: What is in notes.txt?',
    '[2026-10-07 09:02] Planner: It says:',
    '    hello',
    '    world',
    '[2026-10-07 09:03] You (routine): Daily plan?',
    '',
  ].join('\n'));
  assert.doesNotMatch(text, /secret file text/);
});

test('room export: room name in the header, each reply under its bot\'s name (deleted bot → "Cipher bot")', () => {
  const msgs: RoomMessage[] = [
    { id: 1, roomId: 1, role: 'user', botId: null, content: 'Plan Friday', createdAt: at(8, 0) },
    { id: 2, roomId: 1, role: 'assistant', botId: 7, content: 'Sure.', createdAt: at(8, 1) },
    { id: 3, roomId: 1, role: 'assistant', botId: null, content: 'Old reply', createdAt: at(8, 2) },
  ];
  const names = new Map([[7, 'Scout']]);
  const text = formatChatExport({ kind: 'room', name: 'Team', exportedAt: new Date(2026, 9, 7, 11, 0), lines: roomExportLines(msgs, (id) => (id === null ? null : names.get(id) ?? null)) });
  assert.equal(text, [
    'Cipher chat export', 'Room: Team', 'Exported: 2026-10-07 11:00', '',
    '[2026-10-07 08:00] You: Plan Friday',
    '[2026-10-07 08:01] Scout: Sure.',
    '[2026-10-07 08:02] Cipher bot: Old reply',
    '',
  ].join('\n'));
});

test('empty chat export says so', () => {
  const text = formatChatExport({ kind: 'bot', name: 'A', exportedAt: new Date(2026, 9, 7, 10, 0), lines: [] });
  assert.match(text, /\n\n\(No messages\)\n$/);
});

test('default file name is <name>-chat.txt without characters file systems reject', () => {
  assert.equal(exportFileName('Planner'), 'Planner-chat.txt');
  assert.equal(exportFileName('Notes: a/b\\c*?"<>|'), 'Notes abc-chat.txt');
  assert.equal(exportFileName('../..'), 'cipher-chat.txt');
  assert.equal(exportFileName('   '), 'cipher-chat.txt');
});

test('export stays local: main.ts writes the file after a native Save dialog; the export module has no network code', () => {
  const main = fs.readFileSync(require.resolve('../main/main.js'), 'utf8');
  assert.match(main, /showSaveDialog/);
  const mod = fs.readFileSync(require.resolve('../main/exportChat.js'), 'utf8');
  assert.doesNotMatch(mod, /require\(["'](node:)?(http|https|net|dgram)["']\)|fetch\(/);
});
