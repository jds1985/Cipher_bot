// Types shared between main, preload and renderer (type-only; no runtime code).

export interface Bot {
  id: number;
  name: string;
  systemPrompt: string;
  toolsEnabled: boolean;
  folderPath: string | null;
  createdAt: string;
  /**
   * Icon shape key from Liz's v1.5 set (hex, circle, square, diamond, triangle, shield, octagon, capsule,
   * pentagon, chip, antenna, monitor), picked on create. Always a known key: unknown stored values come through as 'hex'.
   */
  shape: string;
  /** Icon color key from the fixed palette (blue = #5b8cff, …). Always a known key: unknown values come through as 'blue'. */
  color: string;
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
  /** Icon shape key; anything not on the whitelist is stored as the default. */
  shape?: string;
  /** Icon color key; anything not on the whitelist is stored as the default. */
  color?: string;
}

/** A group chat: two or more Cipher bots and the user. */
export interface Room {
  id: number;
  /** Optional name; empty means "show the members' names". */
  name: string;
  /** Member bot ids in member order (the order bots reply in). */
  memberIds: number[];
  createdAt: string;
  updatedAt: string;
}

export interface RoomMessage {
  id: number;
  roomId: number;
  /** 'user' for the user's messages, 'assistant' for a bot's reply (botId says which bot). */
  role: 'user' | 'assistant';
  botId: number | null;
  content: string;
  createdAt: string;
}

export interface NewRoomForm {
  name: string;
  botIds: number[];
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

/** Events streamed from main to renderer while a room round is running. */
export type RoomEvent =
  | { roomId: number; type: 'speaker'; botId: number }
  | { roomId: number; type: 'token'; botId: number; text: string }
  | { roomId: number; type: 'message'; message: RoomMessage }
  | { roomId: number; type: 'done' }
  | { roomId: number; type: 'error'; error: string };

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
  /** Picked icon shape key. */
  shape: string;
  /** Picked icon color key. */
  color: string;
}

/** Phone link panel status from main. */
export interface PhoneLinkStatus {
  running: boolean;
  port: number;
  pairingCode: string | null;
  pairingExpiresAt: number | null;
  urls: string[];
  sessionCount: number;
}

/** API exposed by the preload script on window.cipher. */
export interface CipherApi {
  listBots(): Promise<Bot[]>;
  createBot(bot: NewBotForm): Promise<Bot>;
  setBotFolder(botId: number, folderPath: string | null): Promise<Bot>;
  setBotTools(botId: number, enabled: boolean): Promise<Bot>;
  pickFolder(): Promise<string | null>;
  /** The bot's one chat (its most recent one), created on first open. */
  openBotChat(botId: number): Promise<Chat>;
  listMessages(chatId: number): Promise<Message[]>;
  sendMessage(chatId: number, text: string): Promise<void>;
  stop(chatId: number): Promise<void>;
  onChatEvent(cb: (e: ChatEvent) => void): () => void;
  listRooms(): Promise<Room[]>;
  createRoom(room: NewRoomForm): Promise<Room>;
  listRoomMessages(roomId: number): Promise<RoomMessage[]>;
  sendRoomMessage(roomId: number, text: string): Promise<void>;
  stopRoom(roomId: number): Promise<void>;
  onRoomEvent(cb: (e: RoomEvent) => void): () => void;
  getSetup(): Promise<SetupState>;
  /** Check and, if needed, download (used on launch, "Try again", "Set up again", "Check again"). */
  startSetup(): Promise<void>;
  /** Check only, without downloading (used after a chat error). */
  checkSetup(): Promise<void>;
  /** Open the engine's download page in the system browser (explicit click only; blocked while Online is off). */
  openEngineDownload(): Promise<void>;
  onSetupState(cb: (s: SetupState) => void): () => void;
  /** Online switch: default off; persists; enables nothing new in v1.6 when on. */
  getOnline(): Promise<boolean>;
  setOnline(on: boolean): Promise<boolean>;
  /** Phone link: start/stop LAN server, refresh pairing code, read status. */
  getPhoneLink(): Promise<PhoneLinkStatus>;
  startPhoneLink(): Promise<PhoneLinkStatus>;
  stopPhoneLink(): Promise<PhoneLinkStatus>;
  refreshPhoneLinkCode(): Promise<PhoneLinkStatus>;
  onPhoneLink(cb: (s: PhoneLinkStatus) => void): () => void;
}
