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
  /** True for a user message sent by the bot's daily routine (not typed by the user). */
  routine: boolean;
}

/** A bot's daily routine: a saved prompt sent to its chat at a local time (at most one per bot). */
export interface Routine {
  botId: number;
  prompt: string;
  /** Local time of day, "HH:MM" (24-hour). */
  time: string;
  enabled: boolean;
  /** Local date ("YYYY-MM-DD") of the last run, or null if it never ran. */
  lastRunDate: string | null;
}

/** Fields on the routine panel. */
export interface RoutineForm {
  prompt: string;
  time: string;
  enabled: boolean;
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
  /** Recommended LAN URL encoded in the QR (URL only; pairing code is separate). */
  primaryUrl: string | null;
  /** PNG data URL for the QR of primaryUrl, or null while generating / stopped. */
  qrDataUrl: string | null;
}

/** API exposed by the preload script on window.cipher. */
/** Result of picking a file to attach into a 1:1 chat message (desktop only). */
export type AttachPickResult =
  | { ok: true; relPath: string; block: string }
  | { ok: false; error: string; needFolder?: boolean };

/** Result of exporting the open chat to a text file. */
export type ExportChatResult =
  | { ok: true; path: string }
  | { ok: false; canceled: true }
  | { ok: false; canceled?: false; error: string };

export interface CipherApi {
  listBots(): Promise<Bot[]>;
  createBot(bot: NewBotForm): Promise<Bot>;
  /** Edit a Cipher bot's name, job, icon shape and color (same fields and validation as create). */
  updateBot(botId: number, bot: NewBotForm): Promise<Bot>;
  setBotFolder(botId: number, folderPath: string | null): Promise<Bot>;
  setBotTools(botId: number, enabled: boolean): Promise<Bot>;
  /** Delete a Cipher bot after the UI confirm step. Cascades chats; removes from rooms. */
  deleteBot(botId: number): Promise<{ deletedRoomIds: number[] }>;
  pickFolder(): Promise<string | null>;
  /**
   * Desktop-only: pick a file inside this bot's folder and read it through the read_file sandbox
   * for inclusion in the next user message. Not available on phone UI.
   */
  pickAttachFile(botId: number): Promise<AttachPickResult>;
  /** The bot's one chat (its most recent one), created on first open. */
  openBotChat(botId: number): Promise<Chat>;
  listMessages(chatId: number): Promise<Message[]>;
  /** Delete the messages of the bot's one chat (after the UI confirm step). The bot and its rooms stay. */
  clearBotChat(botId: number): Promise<Chat>;
  /** The bot's routine, or null if it has none. */
  getRoutine(botId: number): Promise<Routine | null>;
  /** Save the bot's routine (validated in main). */
  setRoutine(botId: number, routine: RoutineForm): Promise<Routine>;
  /** Copy text to the system clipboard (through the main process). */
  copyText(text: string): Promise<void>;
  /** Export a bot's chat or a room to a plain-text file chosen in the native Save dialog. */
  exportChat(kind: 'bot' | 'room', id: number): Promise<ExportChatResult>;
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
