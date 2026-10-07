// v1.10: deleting a bot or a room is refused while it's replying (never stopped to make way).
import type { CipherDb } from './db';

/** True while any of the bot's chats is replying (desktop, phone or routine), or a room it's in is mid-round. */
export function isBotReplying(db: CipherDb, botId: number, activeChatIds: Iterable<number>, activeRoomIds: Iterable<number>): boolean {
  const chats = new Set(db.listChats(botId).map((c) => c.id));
  for (const id of activeChatIds) if (chats.has(id)) return true;
  for (const roomId of activeRoomIds) if (db.getRoom(roomId)?.memberIds.includes(botId)) return true;
  return false;
}

/** Refuse to delete a bot that is replying. */
export function assertBotDeletable(db: CipherDb, botId: number, activeChatIds: Iterable<number>, activeRoomIds: Iterable<number>): void {
  if (isBotReplying(db, botId, activeChatIds, activeRoomIds)) {
    throw new Error('This Cipher bot is still replying. Try again when it has finished.');
  }
}

/** Refuse to delete a room that is mid-round. */
export function assertRoomDeletable(roomId: number, activeRoomIds: Iterable<number>): void {
  for (const id of activeRoomIds) if (id === roomId) throw new Error('This room is still replying. Try again when it has finished.');
}
