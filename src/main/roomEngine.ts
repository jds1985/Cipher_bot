// Group chats ("rooms"): two or more Cipher bots and the user.
//
// Reply rule (one round per user message, never more):
// - After the user posts, every bot in the room replies once, in member order, streaming. Each bot sees the
//   room transcript so far, including the replies earlier bots gave in this round, attributed by name.
// - If the user's message @-mentions a member by name (e.g. "@Ada"), only that bot replies. If several are
//   mentioned, only the first one mentioned replies.
// - Bots never continue on their own: a round is planned once from the user's message and is at most one reply
//   per member. Bot replies (even ones containing "@Name") never start anything.
//
// File reading is OFF in rooms, whatever each bot's own setting: requests carry no tools at all, and the
// system prompt has no tool hint, so one bot's file contents can't reach the other bots.
//
// Streaming, friendly errors and Stop reuse the single-chat code path (streamChat in ollama.ts, the same
// event/abort pattern as runChatTurn in chatEngine.ts).
import type { Bot, RoomEvent, RoomMessage } from '../shared/types';
import type { EngineDeps } from './chatEngine';
import { OLLAMA_HOST, streamChat, type OllamaMessage } from './ollama';

export interface RoomEngineDeps extends Omit<EngineDeps, 'emit'> {
  emit: (e: RoomEvent) => void;
}

const isWordChar = (ch: string): boolean => /[\p{L}\p{N}_]/u.test(ch);

/**
 * The member the message @-mentions, or null. Matching is case-insensitive on the whole name (names may have
 * spaces), must not be glued to other letters on either side, and the earliest mention wins (on a tie, the longer
 * name, so "@Bob" is not read as "@Bo").
 */
export function findMention(text: string, members: readonly Bot[]): Bot | null {
  const lower = text.toLowerCase();
  let best: { bot: Bot; index: number; length: number } | null = null;
  for (const bot of members) {
    const name = bot.name.trim().toLowerCase();
    if (!name) continue;
    const needle = `@${name}`;
    for (let i = lower.indexOf(needle); i >= 0; i = lower.indexOf(needle, i + 1)) {
      const before = i > 0 ? lower[i - 1] : '';
      const after = lower[i + needle.length] ?? '';
      if ((before && isWordChar(before)) || (after && isWordChar(after))) continue;
      if (!best || i < best.index || (i === best.index && needle.length > best.length)) best = { bot, index: i, length: needle.length };
      break;
    }
  }
  return best ? best.bot : null;
}

/**
 * Who replies to one user message, in order: just the mentioned bot, or every member once in member order.
 * Never longer than the member list, and the only thing that decides who speaks in a round.
 */
export function planRound(members: readonly Bot[], userText: string): Bot[] {
  const mentioned = findMention(userText, members);
  return mentioned ? [mentioned] : [...members];
}

/** The short note each bot gets in a room, after its own job. */
export function roomNote(bot: Bot, members: readonly Bot[]): string {
  const names = members.map((m) => m.name).join(', ');
  return (
    `You are ${bot.name}, one of several Cipher bots in a group chat with the user. ` +
    `Cipher bots in this room: ${names}. ` +
    'Messages from the user start with "User:" and messages from the other Cipher bots start with their name. ' +
    `Reply once, as ${bot.name} only; don't write lines for the user or the other Cipher bots.`
  );
}

/** The room transcript as `bot` sees it: its own job + the room note, its own replies as assistant turns, everyone else attributed by name. */
export function buildRoomHistory(bot: Bot, members: readonly Bot[], messages: readonly RoomMessage[], allBots: readonly Bot[] = members): OllamaMessage[] {
  const nameOf = (id: number | null): string => allBots.find((b) => b.id === id)?.name ?? members.find((b) => b.id === id)?.name ?? 'A Cipher bot';
  const out: OllamaMessage[] = [];
  out.push({ role: 'system', content: [bot.systemPrompt.trim(), roomNote(bot, members)].filter(Boolean).join('\n\n') });
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: `User: ${m.content}` });
    else if (m.botId === bot.id) out.push({ role: 'assistant', content: m.content });
    else out.push({ role: 'user', content: `${nameOf(m.botId)}: ${m.content}` });
  }
  return out;
}

/**
 * Handle one user message in a room: save it, then let each planned bot reply once, streaming. Stops the round
 * on Stop (keeping what was streamed) or on an error (shown with the same friendly wording as single chats).
 */
export async function runRoomTurn(deps: RoomEngineDeps, roomId: number, userText: string, signal: AbortSignal): Promise<void> {
  const { db, emit } = deps;
  const room = db.getRoom(roomId);
  if (!room) throw new Error('Room not found.');
  const text = userText.trim();
  if (!text) throw new Error('Message is empty.');
  const members = room.memberIds.map((id) => db.getBot(id)).filter((b): b is Bot => b !== null);
  if (!members.length) throw new Error('This room has no Cipher bots.');

  emit({ roomId, type: 'message', message: db.addRoomMessage({ roomId, role: 'user', content: text }) });

  const plan = planRound(members, text);
  let speaker: Bot | null = null;
  let partial = '';
  try {
    for (const bot of plan) {
      speaker = bot;
      partial = '';
      emit({ roomId, type: 'speaker', botId: bot.id });
      // Deliberately no `tools`: file reading is off in rooms, regardless of the bot's own setting.
      const { content } = await streamChat({
        model: deps.model,
        host: deps.host ?? OLLAMA_HOST,
        fetchImpl: deps.fetchImpl,
        messages: buildRoomHistory(bot, members, db.listRoomMessages(roomId)),
        signal,
        onToken: (t) => { partial += t; emit({ roomId, type: 'token', botId: bot.id, text: t }); },
      });
      partial = '';
      if (content) emit({ roomId, type: 'message', message: db.addRoomMessage({ roomId, role: 'assistant', botId: bot.id, content }) });
    }
    emit({ roomId, type: 'done' });
  } catch (e) {
    if (signal.aborted) {
      // Keep whatever the current bot streamed before the user pressed Stop; the rest of the round is skipped.
      if (partial && speaker) emit({ roomId, type: 'message', message: db.addRoomMessage({ roomId, role: 'assistant', botId: speaker.id, content: partial }) });
      emit({ roomId, type: 'done' });
      return;
    }
    emit({ roomId, type: 'error', error: e instanceof Error ? e.message : String(e) });
  }
}
