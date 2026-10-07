import Database from 'better-sqlite3';
import type { Bot, Chat, Message, NewBot, Role, Room, RoomMessage, Routine, ToolCall } from '../shared/types';
import { normalizeBotColor, normalizeBotIcon, normalizeBotShape, pickLeastUsedIcon, DEFAULT_BOT_COLOR } from './botIcons';
import { validateBotProfile } from './createBot';
import { validateRoutine } from './routine';

const SCHEMA_VERSION = 5;
/** Longest optional room name. */
export const MAX_ROOM_NAME = 80;
const DEFAULT_CHAT_TITLE = 'New chat';

interface BotRow {
  id: number; name: string; system_prompt: string; tools_enabled: number; folder_path: string | null; created_at: string;
  icon: string | null; shape: string | null; color: string | null;
}
interface ChatRow { id: number; bot_id: number; title: string; created_at: string; updated_at: string }
interface MessageRow { id: number; chat_id: number; role: Role; content: string; tool_calls: string | null; tool_name: string | null; created_at: string; routine: number }
interface RoutineRow { bot_id: number; prompt: string; time: string; enabled: number; last_run_date: string | null }
interface RoomRow { id: number; name: string; created_at: string; updated_at: string }
interface RoomMessageRow { id: number; room_id: number; role: 'user' | 'assistant'; bot_id: number | null; content: string; created_at: string }

const toBot = (r: BotRow): Bot => ({
  id: r.id, name: r.name, systemPrompt: r.system_prompt, toolsEnabled: r.tools_enabled === 1,
  folderPath: r.folder_path, createdAt: r.created_at, shape: normalizeBotShape(r.shape), color: normalizeBotColor(r.color),
});
const toChat = (r: ChatRow): Chat => ({
  id: r.id, botId: r.bot_id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at,
});
const toMessage = (r: MessageRow): Message => ({
  id: r.id, chatId: r.chat_id, role: r.role, content: r.content,
  toolCalls: r.tool_calls ? (JSON.parse(r.tool_calls) as ToolCall[]) : null,
  toolName: r.tool_name, createdAt: r.created_at, routine: r.routine === 1,
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
}

/** Local SQLite store for bots, chats, messages and rooms. */
export class CipherDb {
  private db: Database.Database;

  constructor(file: string) {
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
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
    if (version < SCHEMA_VERSION) this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  private addColumnIfMissing(table: 'bots' | 'chats' | 'messages', column: string, definition: string): void {
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

  // ---- bots ----
  listBots(): Bot[] {
    return (this.db.prepare('SELECT * FROM bots ORDER BY id').all() as BotRow[]).map(toBot);
  }

  getBot(id: number): Bot | null {
    const r = this.db.prepare('SELECT * FROM bots WHERE id = ?').get(id) as BotRow | undefined;
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
    return (this.db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY id').all(chatId) as MessageRow[]).map(toMessage);
  }

  addMessage(m: NewMessage): Message {
    const tx = this.db.transaction((): number => {
      const info = this.db
        .prepare('INSERT INTO messages (chat_id, role, content, tool_calls, tool_name, routine) VALUES (?, ?, ?, ?, ?, ?)')
        .run(m.chatId, m.role, m.content, m.toolCalls && m.toolCalls.length ? JSON.stringify(m.toolCalls) : null, m.toolName ?? null,
          m.routine && m.role === 'user' ? 1 : 0);
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
    return (this.db.prepare('SELECT bot_id FROM room_members WHERE room_id = ? ORDER BY position, bot_id').all(roomId) as { bot_id: number }[])
      .map((r) => r.bot_id);
  }

  private toRoom(r: RoomRow): Room {
    return { id: r.id, name: r.name, memberIds: this.roomMemberIds(r.id), createdAt: r.created_at, updatedAt: r.updated_at };
  }

  listRooms(): Room[] {
    return (this.db.prepare('SELECT * FROM rooms ORDER BY id').all() as RoomRow[]).map((r) => this.toRoom(r));
  }

  getRoom(id: number): Room | null {
    const r = this.db.prepare('SELECT * FROM rooms WHERE id = ?').get(id) as RoomRow | undefined;
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
