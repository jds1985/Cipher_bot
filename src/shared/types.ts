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
  /** Plain-language problem description, or null if everything is fine. */
  problem: string | null;
  /** What the user can do about it: get the engine, or rerun setup. */
  action: 'get-engine' | 'setup' | null;
}

/** Events streamed from main to renderer while a reply is being generated. */
export type ChatEvent =
  | { chatId: number; type: 'token'; text: string }
  | { chatId: number; type: 'message'; message: Message }
  | { chatId: number; type: 'tool'; name: string; path: string; ok: boolean; detail: string }
  | { chatId: number; type: 'done' }
  | { chatId: number; type: 'error'; error: string };

export type SetupPhase = 'checking' | 'engine-missing' | 'model-missing' | 'downloading' | 'ready' | 'error';

/** First-run setup progress, pushed from main to renderer. */
export interface SetupState {
  phase: SetupPhase;
  /** 0–100 while downloading, or null when unknown. */
  percent: number | null;
  completed: number;
  total: number;
  /** Plain-language message for engine-missing / model-missing / error. */
  message: string | null;
}

/** Fields on the "Create a Cipher bot" screen. */
export interface NewBotForm {
  name: string;
  /** What the bot should do; stored as its system prompt. */
  job: string;
}

/** API exposed by the preload script on window.cipher. */
export interface CipherApi {
  listBots(): Promise<Bot[]>;
  createBot(bot: NewBotForm): Promise<Bot>;
  setBotFolder(botId: number, folderPath: string | null): Promise<Bot>;
  setBotTools(botId: number, enabled: boolean): Promise<Bot>;
  pickFolder(): Promise<string | null>;
  listChats(botId: number): Promise<Chat[]>;
  createChat(botId: number): Promise<Chat>;
  listMessages(chatId: number): Promise<Message[]>;
  sendMessage(chatId: number, text: string): Promise<void>;
  stop(chatId: number): Promise<void>;
  onChatEvent(cb: (e: ChatEvent) => void): () => void;
  getSetup(): Promise<SetupState>;
  /** Check and, if needed, download (used on launch, "Try again", "Set up again", "Check again"). */
  startSetup(): Promise<void>;
  /** Check only, without downloading (used after a chat error). */
  checkSetup(): Promise<void>;
  /** Open the engine's download page in the system browser (explicit click only). */
  openEngineDownload(): Promise<void>;
  onSetupState(cb: (s: SetupState) => void): () => void;
}
