import Database from 'better-sqlite3';
import type { Bot, Chat, Message, NewBot, Role, ToolCall } from '../shared/types';

const SCHEMA_VERSION = 1;
const DEFAULT_CHAT_TITLE = 'New chat';

interface BotRow { id: number; name: string; system_prompt: string; tools_enabled: number; folder_path: string | null; created_at: string }
interface ChatRow { id: number; bot_id: number; title: string; created_at: string; updated_at: string }
interface MessageRow { id: number; chat_id: number; role: Role; content: string; tool_calls: string | null; tool_name: string | null; created_at: string }

const toBot = (r: BotRow): Bot => ({
  id: r.id, name: r.name, systemPrompt: r.system_prompt, toolsEnabled: r.tools_enabled === 1,
  folderPath: r.folder_path, createdAt: r.created_at,
});
const toChat = (r: ChatRow): Chat => ({
  id: r.id, botId: r.bot_id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at,
});
const toMessage = (r: MessageRow): Message => ({
  id: r.id, chatId: r.chat_id, role: r.role, content: r.content,
  toolCalls: r.tool_calls ? (JSON.parse(r.tool_calls) as ToolCall[]) : null,
  toolName: r.tool_name, createdAt: r.created_at,
});

export interface NewMessage {
  chatId: number;
  role: Role;
  content: string;
  toolCalls?: ToolCall[] | null;
  toolName?: string | null;
}

/** Local SQLite store for bots, chats and messages. */
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
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    }
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
    const name = String(input.name ?? '').trim();
    if (!name) throw new Error('Bot name is required.');
    if (name.length > 80) throw new Error('Bot name must be 80 characters or fewer.');
    const prompt = String(input.systemPrompt ?? '');
    if (prompt.length > 20000) throw new Error('System prompt is too long (max 20000 characters).');
    const info = this.db
      .prepare('INSERT INTO bots (name, system_prompt, tools_enabled, folder_path) VALUES (?, ?, ?, ?)')
      .run(name, prompt, input.toolsEnabled ? 1 : 0, input.folderPath ?? null);
    return this.getBot(Number(info.lastInsertRowid))!;
  }

  setBotFolder(id: number, folderPath: string | null): Bot {
    this.db.prepare('UPDATE bots SET folder_path = ? WHERE id = ?').run(folderPath, id);
    const bot = this.getBot(id);
    if (!bot) throw new Error('Bot not found.');
    return bot;
  }

  setBotTools(id: number, enabled: boolean): Bot {
    this.db.prepare('UPDATE bots SET tools_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    const bot = this.getBot(id);
    if (!bot) throw new Error('Bot not found.');
    return bot;
  }

  // ---- chats ----
  listChats(botId: number): Chat[] {
    return (this.db.prepare('SELECT * FROM chats WHERE bot_id = ? ORDER BY updated_at DESC, id DESC').all(botId) as ChatRow[]).map(toChat);
  }

  getChat(id: number): Chat | null {
    const r = this.db.prepare('SELECT * FROM chats WHERE id = ?').get(id) as ChatRow | undefined;
    return r ? toChat(r) : null;
  }

  createChat(botId: number, title = DEFAULT_CHAT_TITLE): Chat {
    if (!this.getBot(botId)) throw new Error('Bot not found.');
    const info = this.db.prepare('INSERT INTO chats (bot_id, title) VALUES (?, ?)').run(botId, title);
    return this.getChat(Number(info.lastInsertRowid))!;
  }

  // ---- messages ----
  listMessages(chatId: number): Message[] {
    return (this.db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY id').all(chatId) as MessageRow[]).map(toMessage);
  }

  addMessage(m: NewMessage): Message {
    const tx = this.db.transaction((): number => {
      const info = this.db
        .prepare('INSERT INTO messages (chat_id, role, content, tool_calls, tool_name) VALUES (?, ?, ?, ?, ?)')
        .run(m.chatId, m.role, m.content, m.toolCalls && m.toolCalls.length ? JSON.stringify(m.toolCalls) : null, m.toolName ?? null);
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
}
