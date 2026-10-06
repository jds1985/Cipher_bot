// Types shared between main, preload and renderer (type-only; no runtime code).

export interface Bot {
  id: number;
  name: string;
  systemPrompt: string;
  toolsEnabled: boolean;
  folderPath: string | null;
  createdAt: string;
}

export interface Chat {
  id: number;
  botId: number;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

export type Role = 'user' | 'assistant' | 'tool';

export interface Message {
  id: number;
  chatId: number;
  role: Role;
  content: string;
  toolCalls: ToolCall[] | null;
  toolName: string | null;
  createdAt: string;
}

export interface NewBot {
  name: string;
  systemPrompt: string;
  toolsEnabled: boolean;
  folderPath: string | null;
}

export interface OllamaStatus {
  running: boolean;
  modelPresent: boolean;
  model: string;
  host: string;
  /** Human-readable problem description, or null if everything is fine. */
  problem: string | null;
  /** Exact command the user should run to fix the problem, if any. */
  fixCommand: string | null;
}

/** Events streamed from main to renderer while a reply is being generated. */
export type ChatEvent =
  | { chatId: number; type: 'token'; text: string }
  | { chatId: number; type: 'message'; message: Message }
  | { chatId: number; type: 'tool'; name: string; path: string; ok: boolean; detail: string }
  | { chatId: number; type: 'done' }
  | { chatId: number; type: 'error'; error: string };

/** API exposed by the preload script on window.cipher. */
export interface CipherApi {
  ollamaStatus(): Promise<OllamaStatus>;
  listBots(): Promise<Bot[]>;
  createBot(bot: NewBot): Promise<Bot>;
  setBotFolder(botId: number, folderPath: string | null): Promise<Bot>;
  setBotTools(botId: number, enabled: boolean): Promise<Bot>;
  pickFolder(): Promise<string | null>;
  listChats(botId: number): Promise<Chat[]>;
  createChat(botId: number): Promise<Chat>;
  listMessages(chatId: number): Promise<Message[]>;
  sendMessage(chatId: number, text: string): Promise<void>;
  stop(chatId: number): Promise<void>;
  onChatEvent(cb: (e: ChatEvent) => void): () => void;
}
