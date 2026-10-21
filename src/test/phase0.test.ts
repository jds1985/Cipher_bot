import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { trimHistory, historyBudgetChars, DEFAULT_HISTORY_CHARS, MIN_HISTORY_CHARS } from '../main/historyBudget';
import { buildHistory } from '../main/chatEngine';
import { buildRoomHistory } from '../main/roomEngine';
import type { OllamaMessage } from '../main/ollama';

const turns = (n: number, len = 100): OllamaMessage[] =>
  Array.from({ length: n }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: `${i}:` + 'x'.repeat(len) }));

test('history budget: config from CIPHER_HISTORY_CHARS, default and minimum', () => {
  assert.equal(historyBudgetChars({}), DEFAULT_HISTORY_CHARS);
  assert.equal(historyBudgetChars({ CIPHER_HISTORY_CHARS: '5000' }), 5000);
  assert.equal(historyBudgetChars({ CIPHER_HISTORY_CHARS: '10' }), MIN_HISTORY_CHARS);
  assert.equal(historyBudgetChars({ CIPHER_HISTORY_CHARS: 'nope' }), DEFAULT_HISTORY_CHARS);
});

test('history budget: keeps system prompt + newest turns, drops oldest', () => {
  const sys: OllamaMessage = { role: 'system', content: 'JOB + MEMORY' };
  const out = trimHistory([sys, ...turns(200)], 3000);
  assert.equal(out[0], sys);
  assert.ok(out.length < 201 && out.length > 5);
  assert.ok(out.at(-1)!.content.startsWith('199:'));
  assert.ok(out.reduce((n, m) => n + m.content.length, 0) <= 3000);
});

test('history budget: short chats unchanged; oversized newest message is cut, not dropped', () => {
  const msgs = [{ role: 'system', content: 's' } as OllamaMessage, ...turns(4)];
  assert.deepEqual(trimHistory(msgs, 24000), msgs);
  const big = trimHistory([{ role: 'user', content: 'y'.repeat(50_000) }], 2000);
  assert.equal(big.length, 1);
  assert.ok(big[0].content.length <= 2000);
});

test('history budget: never starts with an orphan tool result', () => {
  const msgs: OllamaMessage[] = [{ role: 'system', content: 's' }, ...turns(30, 200),
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a' } } } as never] },
    { role: 'tool', content: 'z'.repeat(900), tool_name: 'read_file' }, { role: 'user', content: 'ok' }];
  const out = trimHistory(msgs, 1200);
  assert.notEqual(out[1].role, 'tool');
});

test('chat and room histories are trimmed (memory note kept in system prompt)', () => {
  const bot = { id: 1, name: 'A', systemPrompt: 'Be kind.', toolsEnabled: false, folderPath: null, secondFolderPath: null, memoryNote: 'I live in Lyon',
    unread: false, muted: false, archived: false, replyLength: 'normal' } as never;
  const msgs = Array.from({ length: 2000 }, (_, i) => ({ id: i, chatId: 1, role: i % 2 ? 'assistant' : 'user', content: 'w'.repeat(100), toolCalls: null, toolName: null, createdAt: '' })) as never;
  const h = buildHistory(bot, msgs);
  assert.equal(h[0].role, 'system');
  assert.match(h[0].content, /Lyon/);
  assert.ok(h.length < 400);
  const rm = Array.from({ length: 2000 }, (_, i) => ({ id: i, roomId: 1, role: 'user', botId: null, content: 'w'.repeat(100), createdAt: '' })) as never;
  assert.ok(buildRoomHistory(bot, [bot], rm).length < 400);
});

test('unnamed tool calls are never treated as read_file', () => {
  const src = fs.readFileSync(require.resolve('../main/chatEngine'), 'utf8');
  assert.doesNotMatch(src, /function\?\.name \?\? 'read_file'/);
});
