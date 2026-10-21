import type { DroneSpec } from './droneParts';
// Types shared between main, preload and renderer (type-only; no runtime code).

export interface Bot {
  id: number;
  name: string;
  systemPrompt: string;
  toolsEnabled: boolean;
  folderPath: string | null;
  /** v1.15: an optional second local folder, separate from folderPath. Read the same way, only with Read files on. */
  secondFolderPath: string | null;
  /** v1.19: the user's memory note for this bot, added to its system prompt every chat ('' = none). */
  memoryNote: string;
  /** v1.16: a reply arrived while this bot's chat wasn't open (local only; cleared on open). */
  unread: boolean;
  /** v1.20: muted (no tray notice). */
  muted: boolean;
  /** v1.21: archived (hidden from the dock, routine paused; restorable). */
  archived: boolean;
  /** v1.21: reply length. */
  replyLength: 'short' | 'normal' | 'long';
  /** v1.23: per-bot tool switches (files = toolsEnabled). Changed only from the desktop's bot settings. */
  tools?: ToolSwitches;
  /** v1.24: tags (lowercase, up to 5) and dock folder name ('' = none). */
  tags?: string[];
  group?: string;
  createdAt: string;
  /**
   * Icon shape key from Liz's v1.5 set (hex, circle, square, diamond, triangle, shield, octagon, capsule,
   * pentagon, chip, antenna, monitor), picked on create. Always a known key: unknown stored values come through as 'hex'.
   */
  shape: string;
  /** Icon color key from the fixed palette (blue = #5b8cff, …). Always a known key: unknown values come through as 'blue'. */
  color: string;
  /** The bot's drone avatar (shell, palette, eye, fins, crystal, accessories). Always valid (sanitized on load). */
  drone: DroneSpec;
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
  /** v1.18: for a web_search tool message, the query and its results (title, link, snippet); otherwise null. */
  search: { query: string; results: { title: string; url: string; snippet: string }[] } | null;
  /** v1.20: the quoted text this message replies to, or null. */
  quote: string | null;
  /** v1.20: pinned to the top of its chat. */
  pinned: boolean;
  /** v1.20: a dropped image (path relative to the bot's read folder), or "pasted:<id>" (v1.23, bytes in cipher.db), or null. */
  image: string | null;
  /** v1.23: a user message sent by a one-time reminder. */
  reminder?: boolean;
  /** v1.24: the user's reaction (one of five), local only. */
  reaction?: string | null;
  /** v1.24: edited by the user (old versions in message_edits). */
  edited?: boolean;
}

export interface MessageEdit { id: number; messageId: number; oldText: string; editedAt: string }
export interface BotActivity { lastReplyAt: string | null; lastTool: string | null; lastToolAt: string | null }

export interface ToolSwitches { files: boolean; search: boolean; calculator: boolean; checklist: boolean; write: boolean }

/** v1.23: a one-time local reminder. at = local "YYYY-MM-DDTHH:MM". */
export interface Reminder {
  id: number; botId: number; at: string; prompt: string;
  status: 'pending' | 'done' | 'failed' | 'missed' | 'skipped';
  note: string | null; createdAt: string;
}

/** v1.23: Settings → Storage. Sizes in bytes; null = unknown. */
export interface DiskUsage {
  chats: number; files: number | null; filesCapped: boolean; folders: number;
  backups: number | null; backupsNote: string;
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
  /** Drone avatar; sanitized. Omitted -> a default from the name and job. */
  drone?: unknown;
}

/** A group chat: two or more Cipher bots and the user. */
export interface UiPrefsState { showTimes: boolean; dockCollapsed: boolean; reduceMotion: boolean; compact: boolean }
export type AccentName = 'blue' | 'teal' | 'violet' | 'amber' | 'rose';
export interface ChecklistItem { id: number; botId: number; text: string; done: boolean; createdAt: string }

export interface Room {
  id: number;
  /** Optional name; empty means "show the members' names". */
  name: string;
  /** Member bot ids in member order (the order bots reply in). */
  memberIds: number[];
  createdAt: string;
  updatedAt: string;
  /** v1.16: a reply arrived while this room wasn't open (local only; cleared on open). */
  unread: boolean;
  /** v1.20: muted (no tray notice). */
  muted: boolean;
  /** v1.21: archived (hidden from the dock; restorable). */
  archived: boolean;
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

export interface BackendStatus {
  /** cipher-serve answered /health. */
  running: boolean;
  model: string | null;
  nCtx: number | null;
  /** Plain-language problem description, or null if everything is fine. */
  problem: string | null;
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

export type SetupPhase = 'checking' | 'starting' | 'ready' | 'error';

/** Model server state (bundled cipher-serve + Cipher model), pushed from main to renderer. */
export interface SetupState {
  phase: SetupPhase;
  /** Plain-language message for 'error' (and 'starting' when a restart is in progress), else null. */
  message: string | null;
  /** The running model's display name, once known. */
  model: string | null;
  /** Whether this model may be offered tools (false on the 135M stand-in: tools are switched off, not faked). */
  toolCalling: boolean;
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
  /** Drone avatar picked in the builder (sanitized in main). Omitted on edit -> unchanged. */
  drone?: DroneSpec;
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
  setBotSecondFolder(botId: number, folderPath: string | null): Promise<Bot>;
  setBotTools(botId: number, enabled: boolean): Promise<Bot>;
  /** Delete a Cipher bot after the UI confirm step. Cascades chats; removes from rooms. */
  deleteBot(botId: number): Promise<{ deletedRoomIds: number[]; undoId?: string }>;
  /** Delete a room and its messages after the UI confirm step (refused while it's replying). Bots stay. */
  deleteRoom(roomId: number): Promise<{ undoId?: string } | void>;
  /** Right-click on a bot or room in the left column: native menu; resolves 'delete' or null. */
  showItemMenu(kind: 'bot' | 'room'): Promise<'delete' | 'archive' | null>;
  pickFolder(): Promise<string | null>;
  /**
   * Desktop-only: pick a file inside this bot's folder and read it through the read_file sandbox
   * for inclusion in the next user message. Not available on phone UI.
   */
  pickAttachFile(botId: number): Promise<AttachPickResult>;
  /** v1.17: the local path of a dropped file (webUtils.getPathForFile); '' if it isn't a file on this computer. */
  pathForFile(file: File): string;
  /** v1.17: attach a dropped file, through the same checks as pickAttachFile. */
  attachDroppedFile(botId: number, filePath: string): Promise<AttachPickResult>;
  /** v1.17: display preferences (message times, dock collapsed), stored locally. */
  getUiPrefs(): Promise<UiPrefsState>;
  setUiPref(name: 'showTimes' | 'dockCollapsed' | 'reduceMotion' | 'compact', value: boolean): Promise<UiPrefsState>;
  /** v1.22: accent color (blue, teal, violet, amber, rose). */
  getAccent(): Promise<AccentName>;
  setAccent(accent: AccentName): Promise<AccentName>;
  /** v1.22: save a message's text into its bot's memory note (one tap; refused clearly when the 2000-char note is full). */
  rememberMessage(chatId: number, messageId: number): Promise<Bot>;
  /** v1.22: a bot's checklist (cipher.db). The user adds, checks and deletes; a bot only adds after a native confirm. */
  checklist(botId: number): Promise<ChecklistItem[]>;
  checklistAdd(botId: number, text: string): Promise<ChecklistItem[]>;
  checklistSetDone(botId: number, itemId: number, done: boolean): Promise<ChecklistItem[]>;
  checklistDelete(botId: number, itemId: number): Promise<ChecklistItem[]>;
  onChecklist(cb: (botId: number) => void): () => void;
  /** The bot's one chat (its most recent one), created on first open. */
  openBotChat(botId: number): Promise<Chat>;
  listMessages(chatId: number): Promise<Message[]>;
  /** Delete the messages of the bot's one chat (after the UI confirm step). The bot and its rooms stay. */
  clearBotChat(botId: number): Promise<Chat & { undoId?: string }>;
  /** The bot's routine, or null if it has none. */
  getRoutine(botId: number): Promise<Routine | null>;
  /** Save the bot's routine (validated in main). */
  setRoutine(botId: number, routine: RoutineForm): Promise<Routine>;
  /** Copy text to the system clipboard (through the main process). */
  copyText(text: string): Promise<void>;
  /** Export a bot's chat or a room to a plain-text file chosen in the native Save dialog. */
  exportChat(kind: 'bot' | 'room', id: number): Promise<ExportChatResult>;
  /** v1.20: extras: a message of this chat to quote and/or a dropped image (folder-relative path). */
  sendMessage(chatId: number, text: string, extras?: { quoteId?: number; image?: string }): Promise<void>;
  stop(chatId: number): Promise<void>;
  onChatEvent(cb: (e: ChatEvent) => void): () => void;
  listRooms(): Promise<Room[]>;
  createRoom(room: NewRoomForm): Promise<Room>;
  listRoomMessages(roomId: number): Promise<RoomMessage[]>;
  sendRoomMessage(roomId: number, text: string): Promise<void>;
  stopRoom(roomId: number): Promise<void>;
  onRoomEvent(cb: (e: RoomEvent) => void): () => void;
  getSetup(): Promise<SetupState>;
  /** (Re)start the bundled model server if it isn't running ("Try again"). */
  startSetup(): Promise<void>;
  /** Health-check the model server (used after a chat error). */
  checkSetup(): Promise<void>;
  onSetupState(cb: (s: SetupState) => void): () => void;
  /** Tell main which bot's 1:1 chat is on screen (null: a room, another screen, or nothing), for the routine notice. */
  reportOpenBot(botId: number | null): void;
  /** v1.16: tell main which room is on screen (null: none), so a finished reply there leaves no unread dot. */
  reportOpenRoom(roomId: number | null): void;
  /** v1.16: clear a bot's or room's unread dot (when the user opens it). */
  markRead(kind: 'bot' | 'room', id: number): Promise<void>;
  /** v1.16: main changed an unread dot; reload the lists. */
  onUnreadChanged(cb: () => void): () => void;
  /** v1.16: the app version, from app.getVersion() in main. */
  getVersion(): Promise<string>;
  /** v1.16: optional send sound; off by default. */
  getSendSound(): Promise<boolean>;
  setSendSound(on: boolean): Promise<boolean>;
  /** Clicking a routine notice asks the window to open that bot's chat. */
  onOpenBot(cb: (botId: number) => void): () => void;
  /** v1.18: a confirm card for a web search the bot wants to make (main asks; nothing is sent before Search). */
  onSearchAsk(cb: (ask: { id: string; chatId: number; query: string }) => void): () => void;
  /** v1.18: a confirm card was answered, timed out, or closed by Online off / lock. */
  onSearchClosed(cb: (e: { id: string }) => void): () => void;
  /** v1.18: confirm cards still waiting (e.g. after reopening a chat). */
  pendingSearches(): Promise<{ id: string; chatId: number; query: string }[]>;
  /** v1.18: the user pressed Search (true) or Cancel (false) on a confirm card. */
  answerSearch(id: string, ok: boolean): Promise<void>;
  /** v1.18: ISO time of the last search sent, or null (never). The query is not stored. */
  lastSearch(): Promise<string | null>;
  /** v1.18: open a source link from a stored search result in the system browser (http/https, Online on). v1.19: confirm=true asks first. */
  openLink(url: string, confirm?: boolean): Promise<void>;
  /** v1.19: open a saved search result's page as text in this chat (main asks first, showing the URL). */
  openPage(chatId: number, url: string): Promise<{ ok: true; message: Message } | { ok: false; canceled: true }>;
  /** v1.19: a search was just sent (its time only); Settings reloads Last search and history. */
  onSearchSent(cb: (e: { at: string }) => void): () => void;
  /** v1.19: local search history, newest first. */
  searchHistory(): Promise<{ id: number; query: string; searchedAt: string }[]>;
  clearSearchHistory(): Promise<{ id: number; query: string; searchedAt: string }[]>;
  /** v1.19: a bot's memory note ('' clears it). */
  setBotMemory(botId: number, note: string): Promise<Bot>;
  /** v1.21: archive or restore a bot or room (not a delete). Returns the full lists. */
  setArchived(kind: 'bot' | 'room', id: number, archived: boolean): Promise<{ bots: Bot[]; rooms: Room[] }>;
  setReplyLength(botId: number, value: 'short' | 'normal' | 'long'): Promise<Bot>;
  /** v1.21: blocked sites for search (stored in cipher.db). */
  blockedSites(): Promise<string[]>;
  addBlockedSite(site: string): Promise<string[]>;
  removeBlockedSite(site: string): Promise<string[]>;
  /** v1.21: always on top (saved). */
  getAlwaysOnTop(): Promise<boolean>;
  setAlwaysOnTop(on: boolean): Promise<boolean>;
  onAlwaysOnTop(cb: (on: boolean) => void): () => void;
  /** v1.21: first-run tips: true until finished or skipped once. */
  tipsPending(): Promise<boolean>;
  tipsDone(): Promise<void>;
  /** v1.21: copy the bot's chat as Markdown to the clipboard. */
  copyChatMarkdown(botId: number): Promise<{ chars: number }>;
  /** v1.22: the same for a room (or a bot, with kind 'bot'). */
  copyMarkdown(kind: 'bot' | 'room', id: number): Promise<{ chars: number }>;
  /** v1.20: pin/unpin a message; returns the chat's pinned messages. */
  pinMessage(chatId: number, id: number, on: boolean): Promise<Message[]>;
  listPinned(chatId: number): Promise<Message[]>;
  /** v1.20: mute a bot or room (no tray notice). Returns the new state. */
  setMuted(kind: 'bot' | 'room', id: number, muted: boolean): Promise<boolean>;
  /** v1.20: a dropped image, checked under the Attach folder rules; preview is a data: URL from its bytes. */
  attachDroppedImage(botId: number, filePath: string): Promise<{ ok: true; relPath: string; dataUrl: string } | { ok: false; error: string; needFolder?: boolean }>;
  /** v1.20: a message's image as a data: URL (re-read locally), or null. */
  getImage(chatId: number, messageId: number): Promise<string | null>;
  /** v1.20: update check state; download asks first and saves to Downloads (never installs). */
  getUpdate(): Promise<UpdateState>;
  downloadUpdate(): Promise<UpdateState>;
  showUpdateFile(): Promise<void>;
  onUpdate(cb: (s: UpdateState) => void): () => void;
  /** v1.20: save a redacted debug log; chat content only when includeChats is true. */
  exportDebugLog(includeChats: boolean): Promise<{ ok: true; path: string } | { ok: false; canceled?: true; error?: string }>;
  /** v1.19: delete chosen messages of one chat (main asks once). */
  deleteMessages(chatId: number, ids: number[]): Promise<{ deleted: number; canceled?: boolean; undoId?: string }>;
  // ---- v1.23 ----
  setToolSwitches(botId: number, update: Partial<ToolSwitches>): Promise<Bot>;
  undoDelete(undoId: string): Promise<{ restored: number }>;
  pasteImage(chatId: number, bytes: Uint8Array): Promise<{ ok: true; relPath: string; dataUrl: string } | { ok: false; error: string }>;
  discardPastedImage(chatId: number): Promise<void>;
  reminders(botId: number): Promise<Reminder[]>;
  addReminder(botId: number, at: string, prompt: string): Promise<Reminder[]>;
  deleteReminder(botId: number, id: number): Promise<Reminder[]>;
  onReminders(cb: (botId: number) => void): () => void;
  diskUsage(): Promise<DiskUsage>;
  /** Online switch: default off; persists. v1.18: when on, web search works (after the user presses Search). */
  getOnline(): Promise<boolean>;
  setOnline(on: boolean): Promise<boolean>;
  /** Phone link: start/stop LAN server, refresh pairing code, read status. */
  getPhoneLink(): Promise<PhoneLinkStatus>;
  startPhoneLink(): Promise<PhoneLinkStatus>;
  stopPhoneLink(): Promise<PhoneLinkStatus>;
  refreshPhoneLinkCode(): Promise<PhoneLinkStatus>;
  onPhoneLink(cb: (s: PhoneLinkStatus) => void): () => void;
  /** App lock (v1.13). Hashing and checking happen only in main; the passphrase is sent once per call, never kept. */
  getLockState(): Promise<LockState>;
  unlock(passphrase: string): Promise<UnlockResult>;
  enableLock(passphrase: string, confirm: string): Promise<LockState>;
  changeLock(current: string, passphrase: string, confirm: string): Promise<UnlockResult>;
  disableLock(current: string): Promise<UnlockResult>;
  /** Backup: native Save dialog, then a consistent copy of cipher.db (local file; not encrypted; no lock data). */
  backup(): Promise<BackupResult>;
  /** Restore, step 1: native Open dialog and validation; main keeps the chosen file until the confirm. */
  pickRestore(): Promise<RestorePickResult>;
  /** Restore, step 2 (after the confirm): copy of the current DB, replace it, then Cipher restarts. */
  confirmRestore(): Promise<void>;
  // ---- v1.24 ----
  getSharedFolder(): Promise<string | null>;
  pickSharedFolder(): Promise<string | null>;
  clearSharedFolder(): Promise<null>;
  getLockTimeout(): Promise<'1' | '5' | '15' | 'never'>;
  setLockTimeout(v: '1' | '5' | '15' | 'never'): Promise<'1' | '5' | '15' | 'never'>;
  getShowTps(): Promise<boolean>;
  setShowTps(on: boolean): Promise<boolean>;
  getFont(): Promise<'system' | 'sans' | 'serif' | 'mono'>;
  setFont(v: 'system' | 'sans' | 'serif' | 'mono'): Promise<'system' | 'sans' | 'serif' | 'mono'>;
  reactMessage(chatId: number, id: number, reaction: string | null): Promise<Message>;
  editMessage(chatId: number, id: number, text: string): Promise<Message>;
  listMessageEdits(chatId: number, id: number): Promise<MessageEdit[]>;
  botActivity(botId: number): Promise<BotActivity>;
  setBotTags(botId: number, tags: string[]): Promise<Bot>;
  setBotGroup(botId: number, group: string): Promise<Bot>;
  getDockGroupsCollapsed(): Promise<string[]>;
  setDockGroupsCollapsed(list: string[]): Promise<string[]>;
  importReminder(botId: number, line: string): Promise<Reminder[]>;
  summarizeFolder(chatId: number): Promise<{ ok: true } | { ok: false; canceled: true }>;
  getBackupSchedule(): Promise<BackupScheduleState>;
  setBackupSchedule(v: 'off' | 'daily' | 'weekly'): Promise<BackupScheduleState>;
  pickBackupFolder(): Promise<BackupScheduleState>;
  exportSettings(includeMemory: boolean): Promise<{ ok: true; path: string } | { ok: false; canceled: true }>;
  importSettings(includeMemory: boolean): Promise<{ ok: true; applied: number; memory: number } | { ok: false; canceled: true }>;
  // ---- v1.25 ----
  listDrafts(chatId: number): Promise<DraftInfo[]>;
  saveDraft(chatId: number, id: string): Promise<{ ok: boolean; content: string }>;
  discardDraft(chatId: number, id: string): Promise<boolean>;
  onDrafts(cb: (chatId: number) => void): () => void;
  voiceState(): Promise<VoiceState>;
  pickVoiceEngine(): Promise<VoiceState>;
  pickVoiceModel(): Promise<VoiceState>;
  clearVoice(): Promise<VoiceState>;
  transcribe(pcm: Uint8Array): Promise<string>;
  weeklyReport(): Promise<string>;
  saveWeeklyReport(): Promise<{ ok: true; path: string } | { ok: false; canceled: true }>;
}

export interface LockState {
  enabled: boolean;
  locked: boolean;
}

export type UnlockResult = { ok: true } | { ok: false; error: string; waitMs: number };

export type BackupResult = { ok: true; path: string } | { ok: false; canceled: true } | { ok: false; error: string; canceled?: undefined };

export type RestorePickResult =
  | { ok: true; file: string; bots: number; rooms: number }
  | { ok: false; canceled: true }
  | { ok: false; error: string; canceled?: undefined };

/** v1.20: update check state shown in Settings. */
export interface UpdateState {
  available: { version: string; size: number; verified: boolean } | null;
  lastCheck: string | null;
  online: boolean;
  checking: boolean;
  downloading: boolean;
  done: number;
  error: string | null;
  savedTo: string | null;
}


export interface BackupScheduleState { schedule: 'off' | 'daily' | 'weekly'; folder: string | null; last: string | null }
export interface DraftInfo { id: string; path: string; content: string; createdAt: string }
export interface VoiceState { engine: string | null; model: string | null; tested: string }
