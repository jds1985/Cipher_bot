import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { trimHistory, estimateTokens, historyBudgetTokens, SAFETY_MARGIN } from '../main/historyBudget';
import { buildHistory } from '../main/chatEngine';
import { buildRoomHistory } from '../main/roomEngine';
import type { ChatMessage } from '../main/backend';
import { NO_TOOLS_MODEL } from './fakeCipher';

const turns = (n: number, len = 100): ChatMessage[] =>
  Array.from({ length: n }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: `${i}:` + 'x'.repeat(len) }));
const tokens = (ms: ChatMessage[]) => ms.reduce((n, m) => n + estimateTokens(m.content) + 3, 0);

test('token budget: nCtx − reply − margin; estimate over-counts (bytes / 3, UTF-8 aware)', () => {
  assert.equal(historyBudgetTokens(1024, 300), 1024 - 300 - SAFETY_MARGIN);
  assert.equal(historyBudgetTokens(1024, 1020), 64, 'never below a floor');
  assert.equal(estimateTokens('abcdef'), 2);
  assert.equal(estimateTokens('ééé'), 2, '6 UTF-8 bytes');
});

test('history budget: keeps system prompt + newest turns, drops oldest, fits the token budget', () => {
  const sys: ChatMessage = { role: 'system', content: 'JOB + MEMORY' };
  const out = trimHistory([sys, ...turns(200)], 700);
  assert.equal(out[0], sys);
  assert.ok(out.length < 201 && out.length > 5);
  assert.ok(out.at(-1)!.content.startsWith('199:'));
  assert.ok(tokens(out) <= 700);
});

test('history budget: short chats unchanged; oversized newest message is cut, not dropped; huge system prompt capped at half', () => {
  const msgs = [{ role: 'system', content: 's' } as ChatMessage, ...turns(4)];
  assert.deepEqual(trimHistory(msgs, 708), msgs);
  const big = trimHistory([{ role: 'user', content: 'y'.repeat(50_000) }], 500);
  assert.equal(big.length, 1);
  assert.ok(tokens(big) <= 500);
  const hugeSys = trimHistory([{ role: 'system', content: 'z'.repeat(10_000) }, { role: 'user', content: 'hi' }], 600);
  assert.ok(tokens(hugeSys.slice(0, 1)) <= 300);
  assert.equal(hugeSys.at(-1)!.content, 'hi');
});

test('history budget: never starts with an orphan tool result', () => {
  const msgs: ChatMessage[] = [{ role: 'system', content: 's' }, ...turns(30, 200),
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a' } } } as never] },
    { role: 'tool', content: 'z'.repeat(900), tool_name: 'read_file' }, { role: 'user', content: 'ok' }];
  const out = trimHistory(msgs, 400);
  assert.notEqual(out[1].role, 'tool');
});

test('chat and room histories fit the 135M context (memory note kept in system prompt)', () => {
  const bot = { id: 1, name: 'A', systemPrompt: 'Be kind.', toolsEnabled: false, folderPath: null, secondFolderPath: null, memoryNote: 'I live in Lyon',
    unread: false, muted: false, archived: false, replyLength: 'normal' } as never;
  const msgs = Array.from({ length: 2000 }, (_, i) => ({ id: i, chatId: 1, role: i % 2 ? 'assistant' : 'user', content: 'w'.repeat(100), toolCalls: null, toolName: null, createdAt: '' })) as never;
  const h = buildHistory(bot, msgs, NO_TOOLS_MODEL);
  assert.equal(h[0].role, 'system');
  assert.match(h[0].content, /Lyon/);
  assert.ok(tokens(h) <= 1024 - 300 - SAFETY_MARGIN);
  const rm = Array.from({ length: 2000 }, (_, i) => ({ id: i, roomId: 1, role: 'user', botId: null, content: 'w'.repeat(100), createdAt: '' })) as never;
  assert.ok(tokens(buildRoomHistory(bot, [bot], rm, NO_TOOLS_MODEL)) <= 1024 - 300 - SAFETY_MARGIN);
});

test('unnamed tool calls are never treated as read_file', () => {
  const src = fs.readFileSync(require.resolve('../main/chatEngine'), 'utf8');
  assert.doesNotMatch(src, /function\?\.name \?\? 'read_file'/);
});
