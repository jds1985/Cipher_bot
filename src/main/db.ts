import Database from 'better-sqlite3';
import type { Bot, Chat, Message, NewBot, Role, Room, RoomMessage, Routine, ToolCall } from '../shared/types';
import { normalizeBotColor, normalizeBotIcon, normalizeBotShape, pickLeastUsedIcon, DEFAULT_BOT_COLOR } from './botIcons';
import { validateBotProfile } from './createBot';
import { validateRoutine } from './routine';
import { normalizeSite } from './blockedSites';
export { isUrlBlocked, normalizeSite } from './blockedSites';

import { CHECKLIST_MAX_ITEMS, normalizeItem } from './checklist';
import type { ChecklistItem, Reminder, ToolSwitches } from '../shared/types';
import { REMINDERS_MAX, validateReminder } from './reminders';
export const SCHEMA_VERSION = 13;
/** v1.21: reply lengths a bot can have. */
export const REPLY_LENGTHS = ['short', 'normal', 'long'] as const;
export type ReplyLength = (typeof REPLY_LENGTHS)[number];
export const BLOCKED_SITES_MAX = 500;
/** v1.20: longest quoted text kept with a reply. */
export const QUOTE_MAX = 500;
export const MEMORY_NOTE_MAX = 2000;
export const SEARCH_HISTORY_MAX = 200;
/** Longest optional room name. */
export const MAX_ROOM_NAME = 80;
const DEFAULT_CHAT_TITLE = 'New chat';

interface BotRow {
  id: number; name: string; system_prompt: string; tools_enabled: number; folder_path: string | null; created_at: string;
  second_folder_path?: string | null;
  unread?: number;
  memory_note?: string | null;
  muted?: number;
  archived?: number;
  reply_length?: string | null;
  tool_search?: number; tool_calc?: number; tool_checklist?: number; tool_write?: number;
  icon: string | null; shape: string | null; color: string | null;
}
interface ChatRow { id: number; bot_id: number; title: string; created_at: string; updated_at: string }
interface MessageRow { id: number; chat_id: number; role: Role; content: string; tool_calls: string | null; tool_name: string | null; created_at: string; routine: number; search_results?: string | null; quote_text?: string | null; pinned?: number; image_path?: string | null; reminder?: number }
interface RoutineRow { bot_id: number; prompt: string; time: string; enabled: number; last_run_date: string | null }
interface RoomRow { id: number; name: string; created_at: string; updated_at: string; unread?: number; muted?: number; archived?: number }
interface RoomMessageRow { id: number; room_id: number; role: 'user' | 'assistant'; bot_id: number | null; content: string; created_at: string }

const toBot = (r: BotRow): Bot => ({
  id: r.id, name: r.name, systemPrompt: r.system_prompt, toolsEnabled: r.tools_enabled === 1,
  folderPath: r.folder_path, secondFolderPath: r.second_folder_path ?? null, unread: r.unread === 1, memoryNote: r.memory_note ?? '', muted: r.muted === 1, archived: r.archived === 1, replyLength: parseReplyLength(r.reply_length),
  tools: { files: r.tools_enabled === 1, search: r.tool_search === 1, calculator: r.tool_calc === 1, checklist: r.tool_checklist === 1, write: r.tool_write === 1 },
  createdAt: r.created_at, shape: normalizeBotShape(r.shape), color: normalizeBotColor(r.color),
});
export const parseReplyLength = (v: unknown): ReplyLength => (REPLY_LENGTHS as readonly unknown[]).includes(v) ? (v as ReplyLength) : 'normal';

const toChat = (r: ChatRow): Chat => ({
  id: r.id, botId: r.bot_id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at,
});
const toMessage = (r: MessageRow): Message => ({
  id: r.id, chatId: r.chat_id, role: r.role, content: r.content,
  toolCalls: r.tool_calls ? (JSON.parse(r.tool_calls) as ToolCall[]) : null,
  toolName: r.tool_name, createdAt: r.created_at, routine: r.routine === 1, search: parseSearch(r.search_results ?? null),
  quote: r.quote_text ?? null, pinned: r.pinned === 1, image: r.image_path ?? null, reminder: r.reminder === 1,
});
/** v1.18: a stored web-search result set ({ query, results }), or null when absent or unreadable. */
function parseSearch(raw: string | null): Message['search'] {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { query?: unknown; results?: unknown };
    if (typeof v.query !== 'string' || !Array.isArray(v.results)) return null;
    const results = v.results.filter((r): r is { title: string; url: string; snippet: string } =>
      !!r && typeof r.title === 'string' && typeof r.url === 'string' && typeof r.snippet === 'string');
    return { query: v.query, results };
  } catch {
    return null;
  }
}
interface ReminderRow { id: number; bot_id: number; at: string; prompt: string; status: string; note: string | null; created_at: string }
const toReminder = (r: ReminderRow): Reminder => ({
  id: r.id, botId: r.bot_id, at: r.at, prompt: r.prompt, note: r.note, createdAt: r.created_at,
  status: (['pending', 'done', 'failed', 'missed', 'skipped'] as const).find((x) => x === r.status) ?? 'skipped',
});
const toRoutine = (r: RoutineRow): Routine => ({
  botId: r.bot_id, prompt: r.prompt, time: r.time, enabled: r.enabled === 1, lastRunDate: r.last_run_date,
});

const toRoomMessage = (r: RoomMessageRow): RoomMessage => ({
  id: r.id, roomId: r.room_id, role: r.role, botId: r.bot_id, content: r.content, createdAt: r.created_at,
});

export interface NewRoomMessage {
  roomId: number;
  role: 'user' | 'assistant';
  botId?: number | null;
  content: string;
}

export interface NewMessage {
  chatId: number;
  role: Role;
  content: string;
  toolCalls?: ToolCall[] | null;
  toolName?: string | null;
  /** A user message sent by the bot's routine. */
  routine?: boolean;
  /** v1.18: a web_search tool message's results (query, titles, links, snippets), kept in the chat. */
  search?: Message['search'];
  /** v1.20: the quoted text this user message replies to (snapshot, capped). */
  quote?: string | null;
  /** v1.23: sent by a one-time reminder. */
  reminder?: boolean;
  /** v1.20: a dropped image, as a path relative to the bot's read folder. */
  image?: string | null;
}

/** Local SQLite store for bots, chats, messages and rooms. */
export class CipherDb {
  private db: Database.Database;

  constructor(file: string) {
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    // v1.19: deleted content is overwritten with zeros, not just unlinked (search history, memory notes, messages).
    this.db.pragma('secure_delete = ON');
    this.migrate();
  }

  private migrate(): void {
    const version = this.db.pragma('user_version', { simple: true }) as number;
    if (version < 1) {
      this.db.exec(`
        CREATE TABLE bots (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          name          TEXT NOT NULL,
          system_prompt TEXT NOT NULL DEFAULT '',
          tools_enabled INTEGER NOT NULL DEFAULT 0,
          folder_path   TEXT,
          created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE TABLE chats (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          bot_id     INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
          title      TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX chats_bot ON chats(bot_id, updated_at);
        CREATE TABLE messages (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_id    INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
          role       TEXT NOT NULL CHECK (role IN ('user','assistant','tool')),
          content    TEXT NOT NULL DEFAULT '',
          tool_calls TEXT,
          tool_name  TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX messages_chat ON messages(chat_id, id);
      `);
      this.db.pragma('user_version = 1');
    }
    if (version < 2) {
      this.db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      this.db.pragma('user_version = 2');
    }
    // v3: per-bot icon. Idempotent: the column is only added when it's missing.
    this.addColumnIfMissing('bots', 'icon', 'icon TEXT');
    this.backfillIcons();
    // v4 (all steps idempotent; nothing is ever deleted):
    // - bots.shape / bots.color: the icon the user picks on create. Existing bots keep their v1.4 icon as the
    //   shape (same key names) with the default color.
    this.addColumnIfMissing('bots', 'shape', 'shape TEXT');
    this.addColumnIfMissing('bots', 'color', 'color TEXT');
    this.backfillShapes();
    // - chats.hidden: one chat per bot. Each bot's most recent chat stays its chat; older chats are only
    //   flagged hidden (rows and their messages are kept).
    this.addColumnIfMissing('chats', 'hidden', 'hidden INTEGER NOT NULL DEFAULT 0');
    this.hideOlderChats();
    // - rooms (group chats), their members (in member order) and their messages.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE IF NOT EXISTS room_members (
        room_id  INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        bot_id   INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        PRIMARY KEY (room_id, bot_id)
      );
      CREATE TABLE IF NOT EXISTS room_messages (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id    INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        role       TEXT NOT NULL CHECK (role IN ('user','assistant')),
        bot_id     INTEGER REFERENCES bots(id) ON DELETE SET NULL,
        content    TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS room_messages_room ON room_messages(room_id, id);
    `);
    // v5 (idempotent; nothing is deleted): one optional daily routine per bot (deleted with its bot), and
    // messages.routine marks the user messages a routine sent.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS routines (
        bot_id        INTEGER PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
        prompt        TEXT NOT NULL,
        time          TEXT NOT NULL,
        enabled       INTEGER NOT NULL DEFAULT 0,
        last_run_date TEXT,
        updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
    this.addColumnIfMissing('messages', 'routine', 'routine INTEGER NOT NULL DEFAULT 0');
    // v6 (idempotent; nothing is deleted): an optional second local folder per bot, separate from folder_path.
    this.addColumnIfMissing('bots', 'second_folder_path', 'second_folder_path TEXT');
    // v7 (idempotent; nothing is deleted): unread dots for bots and rooms with a reply the user hasn't opened yet.
    this.addColumnIfMissing('bots', 'unread', 'unread INTEGER NOT NULL DEFAULT 0');
    this.addColumnIfMissing('rooms', 'unread', 'unread INTEGER NOT NULL DEFAULT 0');
    // v8 (idempotent; nothing is deleted): web search results kept with their tool message.
    this.addColumnIfMissing('messages', 'search_results', 'search_results TEXT');
    // v9 (idempotent): per-bot memory note; local search history.
    this.addColumnIfMissing('bots', 'memory_note', "memory_note TEXT NOT NULL DEFAULT ''");
    // v10 (idempotent): quotes, pins, dropped images, mute.
    this.addColumnIfMissing('messages', 'quote_text', 'quote_text TEXT');
    this.addColumnIfMissing('messages', 'pinned', 'pinned INTEGER NOT NULL DEFAULT 0');
    this.addColumnIfMissing('messages', 'image_path', 'image_path TEXT');
    this.addColumnIfMissing('bots', 'muted', 'muted INTEGER NOT NULL DEFAULT 0');
    this.addColumnIfMissing('rooms', 'muted', 'muted INTEGER NOT NULL DEFAULT 0');
    // v11 (idempotent): archive, reply length, blocked sites.
    this.addColumnIfMissing('bots', 'archived', 'archived INTEGER NOT NULL DEFAULT 0');
    this.addColumnIfMissing('rooms', 'archived', 'archived INTEGER NOT NULL DEFAULT 0');
    this.addColumnIfMissing('bots', 'reply_length', "reply_length TEXT NOT NULL DEFAULT 'normal'");
    this.db.exec('CREATE TABLE IF NOT EXISTS blocked_sites (site TEXT PRIMARY KEY, added_at TEXT NOT NULL)');
    // v13 (idempotent): per-bot tool switches (every existing bot: all off except files, which keeps its value),
    // soft delete for undo, reminders, pasted images, reminder messages.
    this.addColumnIfMissing('bots', 'tool_search', 'tool_search INTEGER NOT NULL DEFAULT 0');
    this.addColumnIfMissing('bots', 'tool_calc', 'tool_calc INTEGER NOT NULL DEFAULT 0');
    this.addColumnIfMissing('bots', 'tool_checklist', 'tool_checklist INTEGER NOT NULL DEFAULT 0');
    this.addColumnIfMissing('bots', 'tool_write', 'tool_write INTEGER NOT NULL DEFAULT 0');
    this.addColumnIfMissing('bots', 'deleted_batch', 'deleted_batch TEXT');
    this.addColumnIfMissing('rooms', 'deleted_batch', 'deleted_batch TEXT');
    this.addColumnIfMissing('messages', 'deleted_batch', 'deleted_batch TEXT');
    this.addColumnIfMissing('messages', 'reminder', 'reminder INTEGER NOT NULL DEFAULT 0');
    this.db.exec('CREATE TABLE IF NOT EXISTS reminders (id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE, ' +
      "at TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', note TEXT, created_at TEXT NOT NULL)");
    this.db.exec('CREATE TABLE IF NOT EXISTS pasted_images (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE, ' +
      'message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE, mime TEXT NOT NULL, bytes BLOB NOT NULL, created_at TEXT NOT NULL)');
    // v12 (idempotent): checklist items per bot.
    this.db.exec('CREATE TABLE IF NOT EXISTS checklist_items (id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE, ' +
      'text TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS search_history (id INTEGER PRIMARY KEY AUTOINCREMENT, query TEXT NOT NULL, searched_at TEXT NOT NULL)');
    if (version < SCHEMA_VERSION) this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  private addColumnIfMissing(table: 'bots' | 'chats' | 'messages' | 'rooms', column: string, definition: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }

  /** Bots without a shape/color (older databases) get their v1.4 icon as the shape and the default color. */
  private backfillShapes(): void {
    const rows = this.db
      .prepare("SELECT id, icon, shape, color FROM bots WHERE shape IS NULL OR shape = '' OR color IS NULL OR color = ''")
      .all() as { id: number; icon: string | null; shape: string | null; color: string | null }[];
    if (!rows.length) return;
    const update = this.db.prepare('UPDATE bots SET shape = ?, color = ? WHERE id = ?');
    this.db.transaction(() => {
      for (const r of rows) {
        update.run(r.shape ? r.shape : normalizeBotIcon(r.icon), r.color ? r.color : DEFAULT_BOT_COLOR, r.id);
      }
    })();
  }

  /**
   * One chat per bot: keep each bot's most recent visible chat (latest activity, then highest id) and flag any
   * other visible chat of that bot as hidden. Never deletes. Idempotent: afterwards each bot has at most one
   * visible chat, so running it again changes nothing.
   */
  private hideOlderChats(): void {
    this.db.exec(`
      UPDATE chats SET hidden = 1
      WHERE hidden = 0 AND id <> (
        SELECT c2.id FROM chats c2 WHERE c2.bot_id = chats.bot_id AND c2.hidden = 0
        ORDER BY c2.updated_at DESC, c2.id DESC LIMIT 1
      )
    `);
  }

  /** Give every bot without an icon one, in creation order, each time picking the least-used icon. */
  private backfillIcons(): void {
    const missing = this.db
      .prepare("SELECT id FROM bots WHERE icon IS NULL OR icon = '' ORDER BY created_at, id")
      .all() as { id: number }[];
    if (!missing.length) return;
    const tx = this.db.transaction(() => {
      const used = (this.db.prepare("SELECT icon FROM bots WHERE icon IS NOT NULL AND icon <> ''").all() as { icon: string }[])
        .map((r) => r.icon);
      const update = this.db.prepare('UPDATE bots SET icon = ? WHERE id = ?');
      for (const { id } of missing) {
        const icon = pickLeastUsedIcon(used);
        update.run(icon, id);
        used.push(icon);
      }
    });
    tx();
  }

  // ---- settings ----
  /** v1.18: true if this exact link is one of the stored web search results (only those can be opened). */
  isStoredResultUrl(url: string): boolean {
    const rows = this.db.prepare("SELECT search_results FROM messages WHERE search_results IS NOT NULL AND deleted_batch IS NULL AND instr(search_results, ?) > 0").all(JSON.stringify(url).slice(1, -1)) as { search_results: string }[];
    return rows.some((r) => parseSearch(r.search_results)?.results.some((x) => x.url === url) ?? false);
  }

  /** v1.20: one message of a chat (null if it is not in that chat). */
  getMessage(chatId: number, id: number): Message | null {
    const r = this.db.prepare('SELECT * FROM messages WHERE id = ? AND chat_id = ? AND deleted_batch IS NULL').get(id, chatId) as MessageRow | undefined;
    return r ? toMessage(r) : null;
  }

  /** v1.20: pin or unpin a message in its chat. Returns the chat's pinned messages. */
  setPinned(chatId: number, id: number, pinned: boolean): Message[] {
    if (!this.getMessage(chatId, id)) throw new Error('Message not found in this chat.');
    this.db.prepare('UPDATE messages SET pinned = ? WHERE id = ? AND chat_id = ?').run(pinned ? 1 : 0, id, chatId);
    return this.listPinned(chatId);
  }

  listPinned(chatId: number): Message[] {
    return (this.db.prepare('SELECT * FROM messages WHERE chat_id = ? AND pinned = 1 AND deleted_batch IS NULL ORDER BY id').all(chatId) as MessageRow[]).map(toMessage);
  }

  /** v1.20: mute a bot or a room (no tray notice while muted). Unknown ids are ignored. */
  setMuted(kind: 'bot' | 'room', id: number, muted: boolean): void {
    this.db.prepare(`UPDATE ${kind === 'bot' ? 'bots' : 'rooms'} SET muted = ? WHERE id = ?`).run(muted ? 1 : 0, id);
  }

  isMuted(kind: 'bot' | 'room', id: number): boolean {
    const r = this.db.prepare(`SELECT muted FROM ${kind === 'bot' ? 'bots' : 'rooms'} WHERE id = ?`).get(id) as { muted: number } | undefined;
    return r?.muted === 1;
  }

  /** v1.19: a bot's memory note (sent in its system prompt every chat). Up to MEMORY_NOTE_MAX characters; '' clears it. */
  setBotMemory(id: number, note: unknown): Bot {
    if (typeof note !== 'string') throw new Error('The memory note must be text.');
    const t = note.replace(/\r\n?/g, '\n').trim();
    if (t.length > MEMORY_NOTE_MAX) throw new Error(`The memory note is longer than ${MEMORY_NOTE_MAX} characters.`);
    this.db.prepare('UPDATE bots SET memory_note = ? WHERE id = ?').run(t, id);
    this.flushDeleted();
    const bot = this.getBot(id);
    if (!bot) throw new Error('Cipher bot not found.');
    return bot;
  }

  /**
   * v1.22: append a message's text to a bot's memory note (one tap). Refuses, with a clear message, when the result
   * would pass MEMORY_NOTE_MAX; the note is left unchanged then.
   */
  appendBotMemory(id: number, text: unknown): Bot {
    const bot = this.getBot(id);
    if (!bot) throw new Error('Cipher bot not found.');
    if (typeof text !== 'string' || !text.trim()) throw new Error('Nothing to remember.');
    const add = text.replace(/\r\n?/g, '\n').trim();
    const cur = bot.memoryNote.trim();
    const next = cur ? `${cur}\n${add}` : add;
    if (next.length > MEMORY_NOTE_MAX) {
      const free = Math.max(0, MEMORY_NOTE_MAX - cur.length - (cur ? 1 : 0));
      throw new Error(free === 0
        ? `The memory note is full (${MEMORY_NOTE_MAX} characters). Edit it in the bot's settings to make room.`
        : `The memory note is almost full: ${free} of ${MEMORY_NOTE_MAX} characters left, and this message has ${add.length}. Edit the note to make room.`);
    }
    return this.setBotMemory(id, next);
  }

  // ---- v1.23: tool switches ----
  /** Set some of a bot's tool switches (main only, from the desktop's bot settings). files = the Read files switch. */
  setToolSwitches(id: number, update: Partial<ToolSwitches>): Bot {
    if (!this.getBot(id)) throw new Error('Cipher bot not found.');
    const cols: Record<keyof ToolSwitches, string> = { files: 'tools_enabled', search: 'tool_search', calculator: 'tool_calc', checklist: 'tool_checklist', write: 'tool_write' };
    this.db.transaction(() => {
      for (const [k, v] of Object.entries(update) as [keyof ToolSwitches, boolean][]) {
        this.db.prepare(`UPDATE bots SET ${cols[k]} = ? WHERE id = ?`).run(v ? 1 : 0, id);
      }
    })();
    return this.getBot(id)!;
  }

  // ---- v1.23: soft delete (undo for 10 s), then purge for real ----
  /** Hide messages of one chat under `batch`. Returns how many. */
  softDeleteMessages(chatId: number, ids: unknown, batch: string): number {
    if (!Array.isArray(ids) || !ids.length || ids.length > 5000) return 0;
    const clean = ids.filter((x): x is number => Number.isInteger(x) && x > 0);
    const q = this.db.prepare('UPDATE messages SET deleted_batch = ? WHERE id = ? AND chat_id = ? AND deleted_batch IS NULL');
    let n = 0;
    this.db.transaction(() => { for (const id of clean) n += q.run(batch, id, chatId).changes; })();
    return n;
  }

  /** Clear chat, soft: every visible message of the bot's chat goes under `batch`. */
  softClearBotChat(botId: number, batch: string): number {
    const chat = this.getBotChat(botId);
    return this.db.prepare('UPDATE messages SET deleted_batch = ? WHERE chat_id = ? AND deleted_batch IS NULL').run(batch, chat.id).changes;
  }

  /** Delete a bot, soft. Rooms left with fewer than 2 live members are hidden in the same batch. */
  softDeleteBot(id: number, batch: string): { deletedRoomIds: number[] } {
    if (!this.getBot(id)) throw new Error('Cipher bot not found.');
    return this.db.transaction(() => {
      const touched = (this.db.prepare('SELECT room_id FROM room_members WHERE bot_id = ?').all(id) as { room_id: number }[]).map((r) => r.room_id);
      this.db.prepare('UPDATE bots SET deleted_batch = ? WHERE id = ?').run(batch, id);
      const deletedRoomIds: number[] = [];
      for (const roomId of touched) {
        if (!this.getRoom(roomId)) continue;
        if (this.roomMemberIds(roomId).length < 2) {
          this.db.prepare('UPDATE rooms SET deleted_batch = ? WHERE id = ?').run(batch, roomId);
          deletedRoomIds.push(roomId);
        }
      }
      return { deletedRoomIds };
    })();
  }

  softDeleteRoom(id: number, batch: string): void {
    if (!this.getRoom(id)) throw new Error('Room not found.');
    this.db.prepare('UPDATE rooms SET deleted_batch = ? WHERE id = ?').run(batch, id);
  }

  /** Undo: everything hidden under `batch` comes back. Returns how many rows. */
  undoBatch(batch: string): number {
    let n = 0;
    this.db.transaction(() => {
      for (const t of ['bots', 'rooms', 'messages']) n += this.db.prepare(`UPDATE ${t} SET deleted_batch = NULL WHERE deleted_batch = ?`).run(batch).changes;
    })();
    return n;
  }

  /** Purge for real: rows hidden under `batch` (or every hidden row when batch is null) are deleted and the WAL flushed. */
  purgeDeleted(batch: string | null): number {
    const where = batch === null ? 'deleted_batch IS NOT NULL' : 'deleted_batch = ?';
    const args = batch === null ? [] : [batch];
    let n = 0;
    this.db.transaction(() => {
      // Chats whose messages were cleared get their title reset, as Clear chat always did.
      const cleared = (this.db.prepare(`SELECT DISTINCT chat_id FROM messages WHERE ${where}`).all(...args) as { chat_id: number }[]).map((r) => r.chat_id);
      n += this.db.prepare(`DELETE FROM messages WHERE ${where}`).run(...args).changes;
      for (const chatId of cleared) {
        const left = (this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?').get(chatId) as { n: number }).n;
        if (!left) this.db.prepare('UPDATE chats SET title = ? WHERE id = ?').run(DEFAULT_CHAT_TITLE, chatId);
      }
      const bots = (this.db.prepare(`SELECT id FROM bots WHERE ${where}`).all(...args) as { id: number }[]).map((r) => r.id);
      for (const id of bots) {
        this.db.prepare('DELETE FROM checklist_items WHERE bot_id = ?').run(id);
        n += this.db.prepare('DELETE FROM bots WHERE id = ?').run(id).changes; // chats, messages, routines, reminders, members cascade
      }
      n += this.db.prepare(`DELETE FROM rooms WHERE ${where}`).run(...args).changes;
      // A room that lost a member to a purged bot and has fewer than 2 left is deleted, as before.
      this.db.prepare('DELETE FROM rooms WHERE id IN (SELECT r.id FROM rooms r WHERE (SELECT COUNT(*) FROM room_members m WHERE m.room_id = r.id) < 2)').run();
    })();
    if (n) this.flushDeleted();
    return n;
  }

  // ---- v1.23: reminders ----
  listReminders(botId?: number): Reminder[] {
    const rows = (botId === undefined
      ? this.db.prepare('SELECT * FROM reminders ORDER BY at, id').all()
      : this.db.prepare('SELECT * FROM reminders WHERE bot_id = ? ORDER BY at, id').all(botId)) as ReminderRow[];
    return rows.map(toReminder);
  }

  addReminder(botId: number, at: unknown, prompt: unknown): Reminder {
    if (!this.getBot(botId)) throw new Error('Cipher bot not found.');
    const { at: when, prompt: text } = validateReminder(at, prompt);
    const n = (this.db.prepare("SELECT COUNT(*) AS n FROM reminders WHERE bot_id = ? AND status = 'pending'").get(botId) as { n: number }).n;
    if (n >= REMINDERS_MAX) throw new Error(`A Cipher bot can have up to ${REMINDERS_MAX} pending reminders.`);
    const id = Number(this.db.prepare("INSERT INTO reminders (bot_id, at, prompt, status, created_at) VALUES (?, ?, ?, 'pending', ?)")
      .run(botId, when, text, new Date().toISOString()).lastInsertRowid);
    return toReminder(this.db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as ReminderRow);
  }

  setReminderStatus(id: number, status: Reminder['status'], note: string | null = null): void {
    this.db.prepare('UPDATE reminders SET status = ?, note = ? WHERE id = ?').run(status, note, id);
  }

  deleteReminder(botId: number, id: number): Reminder[] {
    this.db.prepare('DELETE FROM reminders WHERE id = ? AND bot_id = ?').run(id, botId);
    this.flushDeleted();
    return this.listReminders(botId);
  }

  // ---- v1.23: pasted images (bytes kept in cipher.db, never in the bot's folder) ----
  addPastedImage(chatId: number, mime: string, bytes: Buffer): number {
    if (!this.getChat(chatId)) throw new Error('Chat not found.');
    return Number(this.db.prepare('INSERT INTO pasted_images (chat_id, mime, bytes, created_at) VALUES (?, ?, ?, ?)')
      .run(chatId, mime, bytes, new Date().toISOString()).lastInsertRowid);
  }

  /** A pasted image of this chat (unsent, or attached to a visible message). */
  getPastedImage(chatId: number, id: number): { mime: string; bytes: Buffer; messageId: number | null } | null {
    const r = this.db.prepare('SELECT mime, bytes, message_id FROM pasted_images WHERE id = ? AND chat_id = ?').get(id, chatId) as
      { mime: string; bytes: Buffer; message_id: number | null } | undefined;
    return r ? { mime: r.mime, bytes: r.bytes, messageId: r.message_id } : null;
  }

  /** Pasted images never sent (chip cleared, app closed): deleted. Called at startup and when a paste is discarded. */
  purgeUnsentPastedImages(chatId?: number): number {
    const n = chatId === undefined
      ? this.db.prepare('DELETE FROM pasted_images WHERE message_id IS NULL').run().changes
      : this.db.prepare('DELETE FROM pasted_images WHERE message_id IS NULL AND chat_id = ?').run(chatId).changes;
    if (n) this.flushDeleted();
    return n;
  }

  /** v1.22: a bot's checklist (oldest first). */
  listChecklist(botId: number): ChecklistItem[] {
    return (this.db.prepare('SELECT id, bot_id, text, done, created_at FROM checklist_items WHERE bot_id = ? ORDER BY id').all(botId) as
      { id: number; bot_id: number; text: string; done: number; created_at: string }[])
      .map((r) => ({ id: r.id, botId: r.bot_id, text: r.text, done: r.done === 1, createdAt: r.created_at }));
  }

  addChecklistItem(botId: number, raw: unknown): ChecklistItem[] {
    if (!this.getBot(botId)) throw new Error('Cipher bot not found.');
    const text = normalizeItem(raw);
    const n = (this.db.prepare('SELECT COUNT(*) AS n FROM checklist_items WHERE bot_id = ?').get(botId) as { n: number }).n;
    if (n >= CHECKLIST_MAX_ITEMS) throw new Error(`The checklist is full (${CHECKLIST_MAX_ITEMS} items).`);
    this.db.prepare('INSERT INTO checklist_items (bot_id, text, done, created_at) VALUES (?, ?, 0, ?)').run(botId, text, new Date().toISOString());
    return this.listChecklist(botId);
  }

  setChecklistDone(botId: number, itemId: number, done: boolean): ChecklistItem[] {
    const r = this.db.prepare('UPDATE checklist_items SET done = ? WHERE id = ? AND bot_id = ?').run(done ? 1 : 0, itemId, botId);
    if (r.changes === 0) throw new Error('Checklist item not found.');
    return this.listChecklist(botId);
  }

  deleteChecklistItem(botId: number, itemId: number): ChecklistItem[] {
    this.db.prepare('DELETE FROM checklist_items WHERE id = ? AND bot_id = ?').run(itemId, botId);
    this.flushDeleted();
    return this.listChecklist(botId);
  }

  /** v1.19: remember a search that was sent (local only). Keeps the newest SEARCH_HISTORY_MAX. */
  addSearchHistory(query: string, at: string): void {
    this.db.prepare('INSERT INTO search_history (query, searched_at) VALUES (?, ?)').run(query, at);
    this.db.prepare('DELETE FROM search_history WHERE id NOT IN (SELECT id FROM search_history ORDER BY id DESC LIMIT ?)').run(SEARCH_HISTORY_MAX);
  }

  listSearchHistory(): { id: number; query: string; searchedAt: string }[] {
    return (this.db.prepare('SELECT id, query, searched_at FROM search_history ORDER BY id DESC').all() as { id: number; query: string; searched_at: string }[])
      .map((r) => ({ id: r.id, query: r.query, searchedAt: r.searched_at }));
  }

  /** Really deletes: secure_delete zeroes the freed pages, and the WAL is checkpointed and truncated so no old copy stays. */
  clearSearchHistory(): void {
    this.db.prepare('DELETE FROM search_history').run();
    this.flushDeleted();
  }

  /** Write the WAL back and truncate it, so deleted text is not left in cipher.db-wal. */
  flushDeleted(): void {
    this.db.pragma('wal_checkpoint(TRUNCATE)');
  }

  /** v1.19: delete chosen messages of one chat. Ids from other chats are ignored. Returns how many were deleted. */
  deleteMessages(chatId: number, ids: unknown): number {
    if (!Array.isArray(ids) || !ids.length || ids.length > 5000) return 0;
    const clean = ids.filter((x): x is number => Number.isInteger(x) && x > 0);
    const del = this.db.prepare('DELETE FROM messages WHERE id = ? AND chat_id = ?');
    let n = 0;
    this.db.transaction(() => { for (const id of clean) n += del.run(id, chatId).changes; })();
    if (n) this.flushDeleted();
    return n;
  }

  getSetting(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return r ? r.value : null;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  close(): void {
    this.db.close();
  }

  /** Write a consistent copy of the whole database to dest (better-sqlite3's online backup API). Local only. */
  async backup(dest: string): Promise<void> {
    await this.db.backup(dest);
  }

  // ---- bots ----
  listBots(): Bot[] {
    return (this.db.prepare('SELECT * FROM bots WHERE deleted_batch IS NULL ORDER BY id').all() as BotRow[]).map(toBot);
  }

  getBot(id: number): Bot | null {
    const r = this.db.prepare('SELECT * FROM bots WHERE id = ? AND deleted_batch IS NULL').get(id) as BotRow | undefined;
    return r ? toBot(r) : null;
  }

  createBot(input: NewBot): Bot {
    // Same validation as edit (validateBotProfile): name, job, and whitelisted shape/color (unknown → default).
    // The v1.4 icon column gets the shape key too, so an older Cipher still shows a matching icon.
    const { name, systemPrompt: prompt, shape, color } = validateBotProfile(input);
    const info = this.db
      .prepare('INSERT INTO bots (name, system_prompt, tools_enabled, folder_path, icon, shape, color) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(name, prompt, input.toolsEnabled ? 1 : 0, input.folderPath ?? null, shape, shape, color);
    return this.getBot(Number(info.lastInsertRowid))!;
  }

  /**
   * Edit a Cipher bot's name, job (system prompt), icon shape and color. Uses the same validator as createBot.
   * File reading, folder and chats are left as they are. The v1.4 icon column follows the shape, as on create.
   */
  updateBot(id: number, input: { name?: unknown; systemPrompt?: unknown; shape?: unknown; color?: unknown }): Bot {
    if (!this.getBot(id)) throw new Error('Cipher bot not found.');
    const { name, systemPrompt, shape, color } = validateBotProfile(input);
    this.db
      .prepare('UPDATE bots SET name = ?, system_prompt = ?, icon = ?, shape = ?, color = ? WHERE id = ?')
      .run(name, systemPrompt, shape, shape, color, id);
    return this.getBot(id)!;
  }

  setBotFolder(id: number, folderPath: string | null): Bot {
    this.db.prepare('UPDATE bots SET folder_path = ? WHERE id = ?').run(folderPath, id);
    const bot = this.getBot(id);
    if (!bot) throw new Error('Cipher bot not found.');
    return bot;
  }

  /** v1.16: set or clear a bot's or room's unread dot. Unknown ids are ignored. */
  setUnread(kind: 'bot' | 'room', id: number, unread: boolean): void {
    this.db.prepare(`UPDATE ${kind === 'bot' ? 'bots' : 'rooms'} SET unread = ? WHERE id = ?`).run(unread ? 1 : 0, id);
  }

  /** The bot's second local folder (v1.15), separate from its read folder. null removes it. */
  setBotSecondFolder(id: number, folderPath: string | null): Bot {
    this.db.prepare('UPDATE bots SET second_folder_path = ? WHERE id = ?').run(folderPath, id);
    const bot = this.getBot(id);
    if (!bot) throw new Error('Cipher bot not found.');
    return bot;
  }

  setBotTools(id: number, enabled: boolean): Bot {
    this.db.prepare('UPDATE bots SET tools_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    const bot = this.getBot(id);
    if (!bot) throw new Error('Cipher bot not found.');
    return bot;
  }

  /**
   * Delete a Cipher bot and its 1:1 chats/messages (FK CASCADE).
   * Also removes the bot from any rooms (room_members CASCADE). Rooms that then have
   * fewer than 2 members are deleted entirely (their messages cascade) — a room needs
   * at least two Cipher bots.
   */
  deleteBot(id: number): { deletedRoomIds: number[] } {
    if (!this.getBot(id)) throw new Error('Cipher bot not found.');
    return this.db.transaction(() => {
      const touched = (
        this.db.prepare('SELECT room_id FROM room_members WHERE bot_id = ?').all(id) as { room_id: number }[]
      ).map((r) => r.room_id);
      this.db.prepare('DELETE FROM checklist_items WHERE bot_id = ?').run(id);
      this.db.prepare('DELETE FROM bots WHERE id = ?').run(id);
      const deletedRoomIds: number[] = [];
      for (const roomId of touched) {
        const left = (
          this.db.prepare('SELECT COUNT(*) AS n FROM room_members WHERE room_id = ?').get(roomId) as { n: number }
        ).n;
        if (left < 2) {
          this.db.prepare('DELETE FROM rooms WHERE id = ?').run(roomId);
          deletedRoomIds.push(roomId);
        }
      }
      return { deletedRoomIds };
    })();
  }

  // ---- chats ----
  listChats(botId: number): Chat[] {
    return (this.db.prepare('SELECT * FROM chats WHERE bot_id = ? ORDER BY updated_at DESC, id DESC').all(botId) as ChatRow[]).map(toChat);
  }

  getChat(id: number): Chat | null {
    const r = this.db.prepare('SELECT * FROM chats WHERE id = ?').get(id) as ChatRow | undefined;
    return r ? toChat(r) : null;
  }

  /**
   * The bot's one chat: its most recent visible chat, or a new one created now (lazily, on first open).
   * Hidden (older) chats are never returned here.
   */
  getBotChat(botId: number): Chat {
    if (!this.getBot(botId)) throw new Error('Cipher bot not found.');
    const r = this.db
      .prepare('SELECT * FROM chats WHERE bot_id = ? AND hidden = 0 ORDER BY updated_at DESC, id DESC LIMIT 1')
      .get(botId) as ChatRow | undefined;
    return r ? toChat(r) : this.createChat(botId);
  }

  createChat(botId: number, title = DEFAULT_CHAT_TITLE): Chat {
    if (!this.getBot(botId)) throw new Error('Cipher bot not found.');
    const info = this.db.prepare('INSERT INTO chats (bot_id, title) VALUES (?, ?)').run(botId, title);
    return this.getChat(Number(info.lastInsertRowid))!;
  }

  /**
   * Clear a bot's chat: delete the messages of its one (visible) chat and reset the title, keeping the chat row,
   * so it stays "one chat per bot" with the same chat id. The bot, its settings, its rooms and room messages,
   * and any older hidden chats are not touched.
   */
  clearBotChat(botId: number): Chat {
    const chat = this.getBotChat(botId); // throws if the bot doesn't exist
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM messages WHERE chat_id = ?').run(chat.id);
      this.db.prepare("UPDATE chats SET title = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(DEFAULT_CHAT_TITLE, chat.id);
    })();
    return this.getChat(chat.id)!;
  }

  // ---- messages ----
  listMessages(chatId: number): Message[] {
    return (this.db.prepare('SELECT * FROM messages WHERE chat_id = ? AND deleted_batch IS NULL ORDER BY id').all(chatId) as MessageRow[]).map(toMessage);
  }

  addMessage(m: NewMessage): Message {
    const tx = this.db.transaction((): number => {
      const info = this.db
        .prepare('INSERT INTO messages (chat_id, role, content, tool_calls, tool_name, routine, search_results, quote_text, image_path, reminder) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(m.chatId, m.role, m.content, m.toolCalls && m.toolCalls.length ? JSON.stringify(m.toolCalls) : null, m.toolName ?? null,
          m.routine && m.role === 'user' ? 1 : 0, m.search && m.role === 'tool' ? JSON.stringify(m.search) : null,
          m.quote && m.role === 'user' ? m.quote.slice(0, QUOTE_MAX) : null, m.image && m.role === 'user' ? m.image : null,
          m.reminder && m.role === 'user' ? 1 : 0);
      // v1.23: a pasted image (bytes in pasted_images) belongs to this message from now on.
      if (m.image?.startsWith('pasted:') && m.role === 'user') {
        this.db.prepare('UPDATE pasted_images SET message_id = ? WHERE id = ? AND chat_id = ? AND message_id IS NULL')
          .run(Number(info.lastInsertRowid), Number(m.image.slice(7)), m.chatId);
      }
      this.db.prepare("UPDATE chats SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(m.chatId);
      // Title a fresh chat after the first user message.
      if (m.role === 'user') {
        const title = m.content.replace(/\s+/g, ' ').trim().slice(0, 48);
        if (title) this.db.prepare('UPDATE chats SET title = ? WHERE id = ? AND title = ?').run(title, m.chatId, DEFAULT_CHAT_TITLE);
      }
      return Number(info.lastInsertRowid);
    });
    const id = tx();
    return toMessage(this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow);
  }

  // ---- routines (v1.9) ----
  /** v1.21: routines of bots that are not archived (an archived bot's routine is paused, not deleted). */
  listActiveRoutines(): Routine[] {
    return (this.db.prepare('SELECT r.* FROM routines r JOIN bots b ON b.id = r.bot_id WHERE b.archived = 0 AND b.deleted_batch IS NULL ORDER BY r.bot_id').all() as RoutineRow[]).map(toRoutine);
  }

  /** v1.21: archive or restore a bot or room. Nothing is deleted. */
  setArchived(kind: 'bot' | 'room', id: number, archived: boolean): void {
    const r = this.db.prepare(`UPDATE ${kind === 'bot' ? 'bots' : 'rooms'} SET archived = ? WHERE id = ?`).run(archived ? 1 : 0, id);
    if (!r.changes) throw new Error(kind === 'bot' ? 'Cipher bot not found.' : 'Room not found.');
  }

  setReplyLength(id: number, value: unknown): Bot {
    if (!(REPLY_LENGTHS as readonly unknown[]).includes(value)) throw new Error('Reply length must be short, normal or long.');
    this.db.prepare('UPDATE bots SET reply_length = ? WHERE id = ?').run(value, id);
    const b = this.getBot(id);
    if (!b) throw new Error('Cipher bot not found.');
    return b;
  }

  listBlockedSites(): string[] {
    return (this.db.prepare('SELECT site FROM blocked_sites ORDER BY site').all() as { site: string }[]).map((r) => r.site);
  }

  addBlockedSite(input: unknown): string[] {
    const site = normalizeSite(input);
    if (!site) throw new Error('Enter a site like example.com.');
    if (this.listBlockedSites().length >= BLOCKED_SITES_MAX) throw new Error('The blocked-sites list is full.');
    this.db.prepare('INSERT OR IGNORE INTO blocked_sites (site, added_at) VALUES (?, ?)').run(site, new Date().toISOString());
    return this.listBlockedSites();
  }

  removeBlockedSite(site: unknown): string[] {
    this.db.prepare('DELETE FROM blocked_sites WHERE site = ?').run(String(site));
    return this.listBlockedSites();
  }

  listRoutines(): Routine[] {
    return (this.db.prepare('SELECT * FROM routines ORDER BY bot_id').all() as RoutineRow[]).map(toRoutine);
  }

  getRoutine(botId: number): Routine | null {
    const r = this.db.prepare('SELECT * FROM routines WHERE bot_id = ?').get(botId) as RoutineRow | undefined;
    return r ? toRoutine(r) : null;
  }

  /**
   * Create or replace the bot's routine (validated by validateRoutine). Changing the time or turning it on
   * keeps the last-run date, so a routine never runs twice on the same day.
   */
  setRoutine(botId: number, input: { prompt?: unknown; time?: unknown; enabled?: unknown }): Routine {
    if (!this.getBot(botId)) throw new Error('Cipher bot not found.');
    const r = validateRoutine(input);
    this.db.prepare(`
      INSERT INTO routines (bot_id, prompt, time, enabled) VALUES (?, ?, ?, ?)
      ON CONFLICT(bot_id) DO UPDATE SET prompt = excluded.prompt, time = excluded.time, enabled = excluded.enabled,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `).run(botId, r.prompt, r.time, r.enabled ? 1 : 0);
    return this.getRoutine(botId)!;
  }

  /** Record that the routine ran on this local date. */
  markRoutineRun(botId: number, dateKey: string): void {
    this.db.prepare('UPDATE routines SET last_run_date = ? WHERE bot_id = ?').run(dateKey, botId);
  }

  // ---- rooms ----
  private roomMemberIds(roomId: number): number[] {
    return (this.db.prepare('SELECT m.bot_id FROM room_members m JOIN bots b ON b.id = m.bot_id WHERE m.room_id = ? AND b.deleted_batch IS NULL ORDER BY m.position, m.bot_id').all(roomId) as { bot_id: number }[])
      .map((r) => r.bot_id);
  }

  private toRoom(r: RoomRow): Room {
    return { id: r.id, name: r.name, memberIds: this.roomMemberIds(r.id), createdAt: r.created_at, updatedAt: r.updated_at, unread: r.unread === 1, muted: r.muted === 1, archived: r.archived === 1 };
  }

  listRooms(): Room[] {
    return (this.db.prepare('SELECT * FROM rooms WHERE deleted_batch IS NULL ORDER BY id').all() as RoomRow[]).map((r) => this.toRoom(r));
  }

  getRoom(id: number): Room | null {
    const r = this.db.prepare('SELECT * FROM rooms WHERE id = ? AND deleted_batch IS NULL').get(id) as RoomRow | undefined;
    return r ? this.toRoom(r) : null;
  }

  /** Create a room with 2+ distinct existing bots; member order is the order given. */
  createRoom(input: { name?: unknown; botIds: unknown }): Room {
    const name = typeof input.name === 'string' ? input.name.replace(/\s+/g, ' ').trim() : '';
    if (name.length > MAX_ROOM_NAME) throw new Error(`Room names must be ${MAX_ROOM_NAME} characters or fewer.`);
    if (!Array.isArray(input.botIds)) throw new Error('Pick at least two Cipher bots for the room.');
    const ids: number[] = [];
    for (const v of input.botIds) {
      if (!Number.isSafeInteger(v) || (v as number) <= 0) throw new Error('Invalid id.');
      if (!ids.includes(v as number)) ids.push(v as number);
    }
    if (ids.length < 2) throw new Error('Pick at least two Cipher bots for the room.');
    for (const id of ids) if (!this.getBot(id)) throw new Error('Cipher bot not found.');
    const id = this.db.transaction((): number => {
      const roomId = Number(this.db.prepare('INSERT INTO rooms (name) VALUES (?)').run(name).lastInsertRowid);
      const add = this.db.prepare('INSERT INTO room_members (room_id, bot_id, position) VALUES (?, ?, ?)');
      ids.forEach((botId, i) => add.run(roomId, botId, i));
      return roomId;
    })();
    return this.getRoom(id)!;
  }

  /** Delete a room (group chat) and its messages (FK CASCADE: members, messages). Bots are not touched. */
  deleteRoom(id: number): void {
    if (!this.getRoom(id)) throw new Error('Room not found.');
    this.db.prepare('DELETE FROM rooms WHERE id = ?').run(id);
  }

  listRoomMessages(roomId: number): RoomMessage[] {
    return (this.db.prepare('SELECT * FROM room_messages WHERE room_id = ? ORDER BY id').all(roomId) as RoomMessageRow[]).map(toRoomMessage);
  }

  addRoomMessage(m: NewRoomMessage): RoomMessage {
    const id = this.db.transaction((): number => {
      const info = this.db
        .prepare('INSERT INTO room_messages (room_id, role, bot_id, content) VALUES (?, ?, ?, ?)')
        .run(m.roomId, m.role, m.role === 'assistant' ? m.botId ?? null : null, m.content);
      this.db.prepare("UPDATE rooms SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(m.roomId);
      return Number(info.lastInsertRowid);
    })();
    return toRoomMessage(this.db.prepare('SELECT * FROM room_messages WHERE id = ?').get(id) as RoomMessageRow);
  }
}
