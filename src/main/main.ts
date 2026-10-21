import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, powerMonitor, screen, session, shell, Tray } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { ChatEvent, NewBotForm, NewRoomForm, Reminder, RoomEvent, SetupState } from '../shared/types';
import { CipherDb, isUrlBlocked } from './db';
import { parseToolUpdate, toolSwitches } from './toolSwitches';
import { ReminderScheduler } from './reminders';
import { diskUsage } from './diskUsage';
import crypto from 'node:crypto';
import { runChatTurn, type ActionHooks } from './chatEngine';
import { WriteConsent, confirmAndWrite } from './fileWrite';
import { confirmChecklistAdd } from './checklist';
import { runRoomTurn } from './roomEngine';
import { SEND_SOUND_SETTING_KEY, parseSendSound, shouldMarkUnread } from './unread';
import { DEFAULT_SIZE, MIN_SIZE, SAVE_DEBOUNCE_MS, debounce, loadWindowState, saveWindowState } from './windowBounds';
import { ACCENT_KEY, UI_PREFS, isUiPrefName, parseAccent, readUiPrefs } from './uiPrefs';
import { formToProfile, toNewBot } from './createBot';
import { chatMarkdown, roomMarkdown } from './chatMarkdown';
import { botChatExportLines, exportFileName, formatChatExport, roomExportLines } from './exportChat';
import { configuredModel, ENGINE_DOWNLOAD_URL } from './ollama';
import { SetupManager } from './setup';
import { ONLINE_SETTING_KEY, assertLinkOpenAllowed, assertOutboundAllowed, onlineSettingValue, parseOnlineSetting } from './networkGuard';
import { webSearch, type SearchResult } from './webSearch';
import { SearchConsent } from './searchConsent';
import { fetchPageText, formatPageBlock } from './pageFetch';
import type { SearchHooks } from './chatEngine';
import { PhoneServer, PHONE_LINK_PORT } from './phoneServer';
import { attachFromPath } from './attachFile';
import { RoutineScheduler } from './routine';
import { assertBotDeletable, assertRoomDeletable } from './deleteGuard';
import { RoutineNotifier, routineOutcome } from './routineNotice';
import { AppLock, LockStore, lockGuard, lockOnHide } from './lock';
import { backupFileName, restoreDatabase, validateBackupFile } from './backup';
import { MAX_IMAGE_BYTES, attachImageFromPath, isImagePath, readImageInFolder, sniffImage, toDataUrl } from './imageAttach';
import { buildDebugLog, recentLogLines, recordLogLine } from './debugLog';
import { SCHEMA_VERSION } from './db';
import { UPDATE_LAST_CHECK_KEY, checkForUpdate, downloadUpdate, isCheckDue, type UpdateInfo } from './updateCheck';
import { readUiPrefs as readPrefsForLog } from './uiPrefs';
import { IDLE_CHECK_MS, LOCK_TIMEOUT_KEY, LOCK_TIMEOUTS, parseLockTimeout, shouldIdleLock } from './lockTimeout';
import { BACKUP_CHECK_MS, BACKUP_FOLDER_KEY, BACKUP_LAST_KEY, BACKUP_SCHEDULE_KEY, BACKUP_SCHEDULES, checkBackupFolder, isBackupDue, parseSchedule, runScheduledBackup } from './scheduledBackup';
import { isNetworkFolder } from './mountInfo';
import { FONT_KEY, FONTS, TPS_KEY, buildSettingsExport, parseFont, parseMemoryImport, parseSettingsImport } from './settingsFile';
import { normalizeGroup, normalizeTags, parseReaction } from './botMeta';
import { confirmFolderSummary } from './folderSummary';
import { PhoneUnlock } from './phoneUnlock';
import { parseReminderLine } from './reminders';
import { MEMORY_NOTE_MAX } from './db';
import { allowPermission, allowPermissionCheck } from './mediaPermission';
import { DraftStore } from './drafts';
import { VOICE_ENGINE_KEY, VOICE_MODEL_KEY, WHISPER_TESTED_VERSION, checkEngine, checkModel, transcribe } from './voice';
import { formatWeeklyReport, weekStart } from './weeklyReport';

// v1.20: keep the last log lines (redacted) for "Export debug log". Still printed as before.
for (const level of ['error', 'warn'] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => { recordLogLine(level, args); orig(...args); };
}

let db: CipherDb;
let setup: SetupManager;
let phone: PhoneServer;
let routines: RoutineScheduler | null = null;
let reminders: ReminderScheduler | null = null;
/** App lock (v1.13). Off unless lock.json exists. While locked, no chat data goes to the window or the phone. */
let appLock: AppLock;
const isLocked = (): boolean => appLock?.isLocked() ?? false;
const activeTurns = new Map<number, AbortController>();
/** Rooms with a round in progress (one round at a time per room). */
const activeRooms = new Map<number, AbortController>();
/** The one model (qwen2.5:7b), or the developer-only CIPHER_MODEL override. Never shown on screen. */
const currentModel = (): string => configuredModel();

function isOnline(): boolean {
  return parseOnlineSetting(db.getSetting(ONLINE_SETTING_KEY));
}

function broadcastSetup(s: SetupState): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.isDestroyed()) w.webContents.send('setup:state', s);
}

function broadcastPhone(): void {
  if (isLocked()) return; // the status carries the pairing code
  const s = phone.status();
  for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.isDestroyed()) w.webContents.send('phone:status', s);
}

function broadcastChat(ev: ChatEvent): void {
  if (isLocked()) return; // while locked, replies (e.g. routines) are saved but not sent to the window
  for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.isDestroyed()) w.webContents.send('chat:event', ev);
}

/** v1.16: after a reply finishes, leave an unread dot on that bot or room unless it's open in the visible, unlocked window. */
function noteReplyFinished(target: { kind: 'bot' | 'room'; id: number } | null, aborted: boolean): void {
  if (!target || quitting) return;
  const win = BrowserWindow.getAllWindows()[0];
  const view = { visible: !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized(), locked: isLocked(), openBotId, openRoomId };
  if (!shouldMarkUnread(target, view, aborted)) return;
  db.setUnread(target.kind, target.id, true);
  if (isLocked()) return; // nothing about it goes to the window while locked
  for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.isDestroyed()) w.webContents.send('unread:changed');
}
const botOfChat = (chatId: number): { kind: 'bot'; id: number } | null => {
  const chat = db.getChat(chatId);
  return chat ? { kind: 'bot', id: chat.botId } : null;
};

function broadcastRoom(ev: RoomEvent): void {
  if (isLocked()) return;
  for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.isDestroyed()) w.webContents.send('room:event', ev);
}

/** Tray icon (close-to-tray). Null when the tray isn't available: then closing the window quits as before. */
let tray: Tray | null = null;
/** True once a real quit has begun (tray Quit, Ctrl+Q, app.quit from anywhere), so close no longer hides. */
let quitting = false;

const dbPath = (): string => path.join(app.getPath('userData'), 'cipher.db');
const appIconPath = (): string => path.join(__dirname, '..', 'renderer', 'assets', 'icon.png');
/** Tray icon: small Hex Circuit variant (tray.png 16px + tray@2x.png 32px picked by Electron per scale factor; Linux scales the 32px one to 22px). */
const trayIconPath = (): string => path.join(__dirname, '..', 'renderer', 'assets', process.platform === 'linux' ? 'tray@2x.png' : 'tray.png');

/** Show and focus the (possibly hidden or minimized) window, or create it if there is none. */
async function showWindow(): Promise<void> {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) { createWindow(); return; }
  // With the lock on, Cipher already locked when the window hid (hideToTray). Safety net: if a hidden window is
  // somehow unlocked, lock and reload the page (lock screen, no chat data) before showing it.
  if (!win.isVisible() && appLock.isEnabled() && !appLock.isLocked()) await lockApp(win);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/**
 * Close to the tray. With the lock on, Cipher locks right here, before the window hides: from then on data IPC
 * refuses, every phone /api/* request gets 423, open phone streams close, and the page is swapped for the lock
 * screen while hidden. A reply already being written keeps running in main and is saved; it can't be read until
 * unlock. Routines keep running. With the lock off, hiding changes nothing (the phone link keeps working).
 */
function hideToTray(win: BrowserWindow): void {
  lockOnHide(appLock, () => void lockApp(win));
  win.hide();
}

/** Page loads done by lockApp; the changing query makes each one a fresh document (a hash-only change wouldn't be). */
let lockLoads = 0;

/** Lock now: replace the window's page with a fresh one (dropping any chat data it held) and stop serving the phone. */
async function lockApp(win: BrowserWindow): Promise<void> {
  appLock.lock();
  killSearch();
  openBotId = null;
  openRoomId = null;
  phone?.closeStreams();
  writeConsent.revokeAll(); // v1.22: unused write / checklist tokens die on lock
  checklistConsent.revokeAll();
  finishUndo(); // v1.23: a pending delete is purged for real on lock (no undo after unlock)
  summaryConsent.revokeAll(); // v1.24: folder-summary tokens and phone unlock sessions die on lock too
  phoneUnlock?.revokeAll();
  drafts.clearAll(); // v1.25: waiting file drafts are dropped on lock (the reloaded page also ends any mic recording)
  if (!win.webContents.isDestroyed()) {
    await win.webContents.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), { query: { lock: String(++lockLoads) }, hash: 'nosplash' })
      .catch(() => undefined);
  }
}

/**
 * Keep Cipher running in the tray when the window is closed. Uses the existing app icon (no new art).
 * Hiding/showing never touches the phone link or the Online setting. If the tray can't be created,
 * tray stays null and closing the window quits as before.
 */
// ---------- v1.21: always on top (title-bar button and tray menu; saved locally) ----------
const ALWAYS_ON_TOP_KEY = 'always_on_top';
const isAlwaysOnTop = (): boolean => db?.getSetting(ALWAYS_ON_TOP_KEY) === '1';
function setAlwaysOnTop(on: boolean): boolean {
  db.setSetting(ALWAYS_ON_TOP_KEY, on ? '1' : '0');
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.setAlwaysOnTop(on);
  rebuildTrayMenu();
  if (!isLocked()) for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.isDestroyed()) w.webContents.send('window:alwaysOnTop', on);
  return on;
}
function rebuildTrayMenu(): void {
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Cipher Bot', click: () => void showWindow() },
    { label: 'Always on top', type: 'checkbox', checked: isAlwaysOnTop(), click: (item) => { setAlwaysOnTop(item.checked); } },
    { type: 'separator' },
    { label: 'Quit Cipher Bot', click: () => { quitting = true; app.quit(); } },
  ]));
}

function createTray(): void {
  try {
    const size = process.platform === 'linux' ? 22 : 16;
    const icon = nativeImage.createFromPath(trayIconPath());
    if (icon.isEmpty()) return;
    tray = new Tray(process.platform !== 'linux' ? icon : icon.resize({ width: size, height: size, quality: 'best' }));
    tray.setToolTip('Cipher Bot');
    rebuildTrayMenu();
    tray.on('click', () => void showWindow());
  } catch {
    tray = null;
  }
}

/** Folders the user picked via the native dialog this session; only these may be attached to a bot. */
const pickedFolders = new Set<string>();

// Local-first: the renderer may only load bundled files. Everything else is blocked.
// (The main process talks to Ollama on 127.0.0.1 only; see ollama.ts.)
function lockDownNetwork(): void {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url;
    callback({ cancel: !(url.startsWith('file://') || url.startsWith('devtools://')) });
  });
  // v1.25: the microphone (audio only, main window's own page) is the one permission ever granted; all else is denied.
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb, details) => cb(allowPermission({
    permission: perm, mediaTypes: (details as { mediaTypes?: string[] }).mediaTypes, isMainWindow: wc.id === mainWebContentsId,
    url: (details as { requestingUrl?: string }).requestingUrl ?? wc.getURL(),
  })));
  session.defaultSession.setPermissionCheckHandler((wc, perm, origin, details) => allowPermissionCheck({
    permission: perm, mediaType: (details as { mediaType?: string }).mediaType, isMainWindow: !!wc && wc.id === mainWebContentsId,
    url: (details as { requestingUrl?: string }).requestingUrl ?? origin,
  }));
  session.defaultSession.setDevicePermissionHandler(() => false);
}
let mainWebContentsId: number | null = null;

/** Cipher window frame colors (match --bg and --accent in styles.css). */
const FRAME_BG = '#15171c';
const FRAME_ACCENT = '#5b8cff';
/**
 * Height of the title strip = Liz's top frame (cipher-frame-top.svg, 40px), so the window controls line up with it.
 * The renderer's #titlebar uses env(titlebar-area-height), falling back to 40px.
 */
const TITLE_BAR_HEIGHT = 40;

/** Windows created so far in this process. Only the first (a real launch) shows the splash. */
let windowsCreated = 0;

function createWindow(): BrowserWindow {
  // v1.17: reopen at the saved size and position, clamped onto a connected display (else the default size, centered).
  const saved = loadWindowState(app.getPath('userData'), screen.getAllDisplays().map((d) => d.workArea));
  const win = new BrowserWindow({
    ...(saved ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height } : DEFAULT_SIZE),
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    resizable: true,
    title: 'Cipher Bot',
    backgroundColor: FRAME_BG,
    // Cipher-colored frame: hide the system title bar and let Electron draw the min/max/close controls
    // (Window Controls Overlay, supported on Windows and Linux; macOS keeps its traffic lights).
    // The renderer draws Liz's draggable top frame underneath.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: FRAME_BG, symbolColor: FRAME_ACCENT, height: TITLE_BAR_HEIGHT },
    icon: appIconPath(),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  mainWebContentsId = win.webContents.id; // v1.25: the only page that may ask for the microphone
  win.removeMenu();
  if (isAlwaysOnTop()) win.setAlwaysOnTop(true); // v1.21: saved choice
  if (saved?.maximized) win.maximize();
  // Save size/position/maximized (debounced). The normal bounds are kept while maximized, so un-maximizing restores them.
  const saveBounds = debounce(() => {
    if (win.isDestroyed() || win.isMinimized()) return;
    saveWindowState(app.getPath('userData'), { ...win.getNormalBounds(), maximized: win.isMaximized() });
  }, SAVE_DEBOUNCE_MS);
  win.on('resize', saveBounds.call);
  win.on('move', saveBounds.call);
  win.on('maximize', saveBounds.call);
  win.on('unmaximize', saveBounds.call);
  win.on('close', saveBounds.flush);
  // Close hides to the tray (Cipher keeps running: phone link, routines and replies continue; with the lock on, it
  // locks as it hides). A real quit closes.
  win.on('close', (e) => {
    if (!quitting && tray && !tray.isDestroyed()) {
      e.preventDefault();
      hideToTray(win);
    }
  });
  // Any other way the window gets hidden locks too (no-op when the lock is off or Cipher is already locked).
  win.on('hide', () => { if (!quitting) lockOnHide(appLock, () => void lockApp(win)); });
  // There's no menu bar, so Ctrl+Q (Cmd+Q) is handled here: it really quits.
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && (input.control || input.meta) && !input.alt && !input.shift && input.key.toLowerCase() === 'q') {
      e.preventDefault();
      quitting = true;
      app.quit();
    }
  });
  // Never navigate away or open new windows from the app.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // Splash on every real launch (process start); a window re-created later in the same process (e.g. macOS dock
  // activate with no window) skips it. Restoring from the tray or a second launch only shows the existing window.
  const splash = windowsCreated++ === 0;
  void win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), splash ? {} : { hash: 'nosplash' });
  return win;
}

const asId = (v: unknown): number => {
  if (!Number.isSafeInteger(v) || (v as number) <= 0) throw new Error('Invalid id.');
  return v as number;
};
const asFolder = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string' || !pickedFolders.has(v)) throw new Error('Please choose the folder with the folder picker.');
  return v;
};

/** Plain text of a bot's chat or a room, plus the name for the header and file name. Local data only. */
function chatExport(kind: unknown, id: number): { name: string; text: string } {
  const exportedAt = new Date();
  if (kind === 'room') {
    const room = db.getRoom(id);
    if (!room) throw new Error('Room not found.');
    const nameOf = (botId: number | null) => (botId === null ? null : db.getBot(botId)?.name ?? null);
    const name = room.name.trim() || room.memberIds.map((b) => nameOf(b)).filter((n): n is string => !!n).join(', ') || 'Room';
    const lines = roomExportLines(db.listRoomMessages(id), nameOf);
    return { name, text: formatChatExport({ kind: 'room', name, exportedAt, lines }) };
  }
  if (kind !== 'bot') throw new Error('Nothing to export.');
  const bot = db.getBot(id);
  if (!bot) throw new Error('Cipher bot not found.');
  const chat = db.getBotChat(id);
  const lines = botChatExportLines(bot, db.listMessages(chat.id));
  return { name: bot.name, text: formatChatExport({ kind: 'bot', name: bot.name, exportedAt, lines }) };
}

/** v1.21: settings key for "first-run tips seen". */
const TIPS_SEEN_KEY = 'tips_seen';

/** Longest text the copy button will put on the clipboard. */
const MAX_COPY_CHARS = 2_000_000;

/** Start a 1:1 turn shared by desktop IPC and phone link. Web search only for the desktop (toolsOff is false). */
/** v1.20: resolve a send's quote (snapshot of a message in this chat) and image (checked again in the bot's folder). */
async function sendExtras(chatId: number, raw: unknown): Promise<{ quote: string | null; image: string | null }> {
  const x = (raw && typeof raw === 'object' ? raw : {}) as { quoteId?: unknown; image?: unknown };
  let quote: string | null = null;
  if (x.quoteId !== undefined && x.quoteId !== null) {
    const m = db.getMessage(chatId, asId(x.quoteId));
    if (!m) throw new Error('The quoted message is gone.');
    quote = m.content;
  }
  let image: string | null = null;
  if (typeof x.image === 'string' && /^pasted:\d+$/.test(x.image)) {
    // v1.23: a pasted image of this chat that hasn't been sent yet.
    const p = db.getPastedImage(chatId, Number(x.image.slice(7)));
    if (!p || p.messageId !== null) throw new Error('The pasted image is gone. Paste it again.');
    return { quote, image: x.image };
  }
  if (typeof x.image === 'string' && x.image) {
    const chat = db.getChat(chatId);
    const bot = chat ? db.getBot(chat.botId) : null;
    image = (await readImageInFolder(bot?.folderPath ?? null, x.image)).relPath;
  }
  return { quote, image };
}

function beginChatTurn(chatId: number, text: string, emit: (e: ChatEvent) => void, signal: AbortSignal, toolsOff: boolean,
  userExtras?: { quote: string | null; image: string | null }): Promise<void> {
  // v1.19: phone turns get web search too (the confirm card shows on the phone and the desktop). Routines never do.
  // v1.22: write_file / checklist_add only on the desktop (toolsOff is true for the phone): the confirm is a native
  // dialog on this computer, so the phone can never approve a write or a checklist item.
  const base = { db, model: currentModel(), emit, forceToolsOff: toolsOff, search: searchHooks, userExtras, sharedFolder };
  return runChatTurn({ ...base, actions: toolsOff ? undefined : actionHooks }, chatId, text, signal);
}

// ---------- v1.22: file writes and checklist adds (native confirm in main, one-time tokens) ----------
const writeConsent = new WriteConsent();
const checklistConsent = new SearchConsent();
/** v1.24: one-time tokens for "Summarize folder" (issued after the native confirm, consumed right before reading). */
const summaryConsent = new SearchConsent();
/** v1.25: file drafts wait here (memory only) until the user saves them through the write confirm, or discards them. */
const drafts = new DraftStore();
/** v1.24: phone challenge-response unlock, verified here in main against the lock hash. Never sent to the phone. */
let phoneUnlock: PhoneUnlock | null = null;
const SHARED_FOLDER_KEY = 'shared_folder';
const DOCK_GROUPS_COLLAPSED_KEY = 'dock_groups_collapsed';
const sharedFolder = (): string | null => db.getSetting(SHARED_FOLDER_KEY) || null;

/** Main's native confirm (never the renderer). Cancel is the default and the Escape answer. */
async function nativeAsk(title: string, t: { message: string; detail: string; buttons: string[] }): Promise<number> {
  if (isLocked()) return 0;
  const parent = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  const opts = { type: 'question' as const, buttons: t.buttons, defaultId: 0, cancelId: 0, noLink: true, title, message: t.message, detail: t.detail };
  const r = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
  return r.response;
}

const actionHooks: ActionHooks = {
  writeFile: (chatId, bot, p, content) => confirmAndWrite(
    { consent: writeConsent, isLocked, ask: (t) => nativeAsk('Write a file', t) }, chatId, bot.name, bot.folderPath, p, content),
  draftFile: async (chatId, bot, p, content) => {
    try {
      const d = drafts.add(chatId, bot.id, p, content);
      sendToWindow('drafts:changed', chatId);
      return { ok: true, path: d.path, content: `Draft ready: ${d.path}. Nothing was written. It waits in the chat until the user saves or discards it.` };
    } catch (err) {
      return { ok: false, path: '', content: `Error: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
  addChecklist: async (chatId, bot, text) => {
    const r = await confirmChecklistAdd({ consent: checklistConsent, isLocked, ask: (t) => nativeAsk('Checklist', t),
      add: (botId, item) => { db.addChecklistItem(botId, item); } }, chatId, bot.id, bot.name, text);
    if (r.ok && !isLocked()) sendToWindow('checklist:changed', bot.id);
    return r;
  },
};

// ---------- v1.18: web search (only while Online is on, only after the user presses Search) ----------
/** Settings key for the time of the last search sent (never the query). */
const LAST_SEARCH_KEY = 'last_search_at';
/** A confirm card nobody answers counts as Cancel after this long. */
const CONFIRM_TIMEOUT_MS = 120_000;
const searchConsent = new SearchConsent();
/** v1.19: one-time tokens for opening a search result page as text, bound to the chat and the exact URL. */
const pageConsent = new SearchConsent();
/** Confirm cards on screen: id → the chat and exact query main asked about. */
const pendingSearchAsks = new Map<string, { chatId: number; query: string; resolve: (token: string | null) => void }>();
/** Searches on the way; Online off or lock aborts them all. */
const activeSearches = new Set<AbortController>();
let searchAskSeq = 0;

function sendToWindow(channel: string, payload: unknown): void {
  if (isLocked()) return;
  for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.isDestroyed()) w.webContents.send(channel, payload);
}

function settleSearchAsk(id: string, token: string | null): void {
  const ask = pendingSearchAsks.get(id);
  if (!ask) return;
  pendingSearchAsks.delete(id);
  ask.resolve(token);
  for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.isDestroyed()) w.webContents.send('search:closed', { id });
  phone?.pushSearchClosed(id, ask.chatId);
}

/**
 * The user's answer on a confirm card main put up (desktop IPC or a paired, unlocked phone session). Only main's own
 * pending ask can get a token, for its chat and exact query, and only while Online is on and Cipher Bot is unlocked.
 */
function answerSearchAsk(id: unknown, ok: unknown): void {
  if (typeof id !== 'string') return;
  const ask = pendingSearchAsks.get(id);
  if (!ask) return;
  settleSearchAsk(id, ok === true && isOnline() && !isLocked() ? searchConsent.issue(ask.chatId, ask.query) : null);
}

/** Online off or lock: abort every search on the way, close every confirm card, forget unused tokens. */
function killSearch(): void {
  for (const c of activeSearches) c.abort();
  activeSearches.clear();
  for (const id of [...pendingSearchAsks.keys()]) settleSearchAsk(id, null);
  searchConsent.revokeAll();
  pageConsent.revokeAll();
  killUpdate(); // v1.20: Online off (or lock) stops an update check or download on the way
}

// ---------- v1.20: update check (only while Online is on; at most once a day; never installs) ----------
let updateController: AbortController | null = null;
let availableUpdate: UpdateInfo | null = null;
let updateStatus: { checking: boolean; downloading: boolean; done: number; error: string | null; savedTo: string | null } =
  { checking: false, downloading: false, done: 0, error: null, savedTo: null };
let updateTimer: NodeJS.Timeout | null = null;
const UPDATE_TIMER_MS = 60 * 60 * 1000;

function updateState() {
  return {
    available: availableUpdate ? { version: availableUpdate.version, size: availableUpdate.size, verified: !!availableUpdate.sha256 } : null,
    lastCheck: db.getSetting(UPDATE_LAST_CHECK_KEY), online: isOnline(), ...updateStatus,
  };
}
function pushUpdateState(): void { sendToWindow('update:state', updateState()); }

function killUpdate(): void {
  if (updateController) updateController.abort();
  updateController = null;
}

/** Timer tick: only when Online is on and the last check was 24 h ago or more. Online is checked again before sending. */
async function maybeCheckForUpdate(): Promise<void> {
  if (!isOnline() || updateController || !isCheckDue(db.getSetting(UPDATE_LAST_CHECK_KEY), Date.now())) return;
  const controller = new AbortController();
  updateController = controller;
  updateStatus = { ...updateStatus, checking: true, error: null };
  try {
    if (!isOnline()) return;
    db.setSetting(UPDATE_LAST_CHECK_KEY, new Date().toISOString());
    availableUpdate = await checkForUpdate(app.getVersion(), { isOnline, signal: controller.signal });
  } catch (err) {
    updateStatus.error = controller.signal.aborted ? null : `Update check failed: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    if (updateController === controller) updateController = null;
    updateStatus.checking = false;
    pushUpdateState();
  }
}

const searchHooks: SearchHooks = {
  isOnline: () => isOnline() && !isLocked(),
  confirm: (chatId, query, signal) => new Promise<string | null>((resolve) => {
    if (!isOnline() || isLocked() || signal.aborted) { resolve(null); return; }
    const id = `s${++searchAskSeq}`;
    const timer = setTimeout(() => settleSearchAsk(id, null), CONFIRM_TIMEOUT_MS);
    const onAbort = () => settleSearchAsk(id, null);
    signal.addEventListener('abort', onAbort, { once: true });
    pendingSearchAsks.set(id, { chatId, query, resolve: (t) => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); resolve(t); } });
    sendToWindow('search:ask', { id, chatId, query });
    phone?.pushSearchAsk({ id, chatId, query });
  }),
  run: async (chatId, query, token, signal): Promise<SearchResult[]> => {
    if (isLocked()) throw new Error('Cipher Bot is locked.');
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    activeSearches.add(controller);
    try {
      // v1.21: results from blocked sites are dropped before they are saved or shown.
      const blocked = db.listBlockedSites();
      return (await webSearch(query, {
        isOnline: () => isOnline() && !isLocked(),
        consumeConsent: (q) => searchConsent.consume(token, chatId, q),
        onSend: () => {
          const at = new Date().toISOString();
          db.setSetting(LAST_SEARCH_KEY, at);
          db.addSearchHistory(query, at);
          sendToWindow('search:sent', { at }); // v1.19: Settings refreshes Last search and history (time only here)
        },
        signal: controller.signal,
      })).filter((r) => !isUrlBlocked(r.url, blocked));
    } finally {
      activeSearches.delete(controller);
      signal.removeEventListener('abort', onAbort);
    }
  },
};

/**
 * Run a bot's routine: its saved prompt goes to the bot's chat as a user message marked as from the routine,
 * and the bot replies through the local model as usual. File reading is always off for routine turns.
 */
function runRoutineTurn(botId: number, chatId: number, prompt: string): void {
  if (activeTurns.has(chatId)) return;
  const controller = new AbortController();
  activeTurns.set(chatId, controller);
  // Note whether the turn failed, for the finished/failed notice (which never includes the prompt or reply).
  let failed = false;
  const emit = (ev: ChatEvent) => { if (ev.type === 'error') failed = true; broadcastChat(ev); };
  void runChatTurn({ db, model: currentModel(), emit, forceToolsOff: true, fromRoutine: true }, chatId, prompt, controller.signal)
    .catch((err: unknown) => { failed = true; broadcastChat({ chatId, type: 'error', error: err instanceof Error ? err.message : String(err) }); })
    .finally(() => {
      activeTurns.delete(chatId);
      noteReplyFinished(botOfChat(chatId), controller.signal.aborted);
      if (!quitting) routineNotifier?.notify(botId, routineOutcome({ aborted: controller.signal.aborted, failed }));
    });
}

/**
 * v1.23: run a one-time reminder like a routine: its prompt goes to the bot's chat marked as a reminder. No web
 * search, no write-file, no checklist (no actions hooks; fromRoutine); read_file and the calculator only if that
 * bot's switches allow them. Runs while locked like routines (nothing is shown in the window while locked); the
 * finished/failed tray notice has the bot's name only and is skipped when the bot is muted.
 */
function runReminderTurn(r: Reminder, chatId: number): void {
  if (activeTurns.has(chatId)) return;
  const controller = new AbortController();
  activeTurns.set(chatId, controller);
  let failed = false;
  const emit = (ev: ChatEvent) => { if (ev.type === 'error') failed = true; broadcastChat(ev); };
  void runChatTurn({ db, model: currentModel(), emit, forceToolsOff: false, fromRoutine: true, reminder: true, sharedFolder }, chatId, r.prompt, controller.signal)
    .catch((err: unknown) => { failed = true; broadcastChat({ chatId, type: 'error', error: err instanceof Error ? err.message : String(err) }); })
    .finally(() => {
      activeTurns.delete(chatId);
      if (failed) db.setReminderStatus(r.id, 'failed', 'The reply failed.');
      sendToWindow('reminders:changed', r.botId);
      noteReplyFinished(botOfChat(chatId), controller.signal.aborted);
      if (!quitting) routineNotifier?.notify(r.botId, routineOutcome({ aborted: controller.signal.aborted, failed }));
    });
}

// ---------- v1.23: undo the last delete for 10 seconds (soft delete, then purge for real) ----------
const UNDO_MS = 10_000;
let pendingUndo: { id: string; timer: ReturnType<typeof setTimeout> } | null = null;
/** Purge the pending delete now (a newer delete, lock, quit). */
function finishUndo(): void {
  if (!pendingUndo) return;
  clearTimeout(pendingUndo.timer);
  const id = pendingUndo.id;
  pendingUndo = null;
  try { db.purgeDeleted(id); } catch { /* purged again at next start */ }
}
/** Start a new soft-delete batch; the previous one (if any) is purged first, so only the last delete can be undone. */
function beginUndo(): string {
  finishUndo();
  const id = crypto.randomBytes(12).toString('hex');
  const timer = setTimeout(() => { if (pendingUndo?.id === id) { pendingUndo = null; db.purgeDeleted(id); } }, UNDO_MS);
  timer.unref?.();
  pendingUndo = { id, timer };
  return id;
}
function undoDelete(id: unknown): { restored: number } {
  if (!pendingUndo || typeof id !== 'string' || pendingUndo.id !== id) throw new Error('Too late to undo: it has been deleted for good.');
  clearTimeout(pendingUndo.timer);
  pendingUndo = null;
  return { restored: db.undoBatch(id) };
}

/** The bot whose 1:1 chat the window shows (reported by the renderer), for the routine notice. */
let openBotId: number | null = null;
/** v1.16: the room the window shows (reported by the renderer), for unread dots. */
let openRoomId: number | null = null;

/** Open a bot's chat in the window (clicking a routine notice). Waits for the page if the window was just created. */
async function openBotChatInWindow(botId: number): Promise<void> {
  await showWindow();
  const win = BrowserWindow.getAllWindows()[0];
  if (!win || win.webContents.isDestroyed()) return;
  const send = () => win.webContents.send('routine:openBot', botId);
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
  else send();
}

/**
 * Routine finished/failed notice through the OS notification service (Electron Notification; no network).
 * Bot name + outcome only; skipped when that bot's chat is open in the focused window; nothing if unsupported.
 */
let routineNotifier: RoutineNotifier | null = null;
function createRoutineNotifier(): RoutineNotifier {
  return new RoutineNotifier({
    isSupported: () => Notification.isSupported(),
    create: ({ title, body }) => {
      const icon = nativeImage.createFromPath(appIconPath());
      return new Notification({ title, body, ...(icon.isEmpty() ? {} : { icon }) });
    },
    windowState: () => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win || win.isDestroyed()) return null;
      return { visible: win.isVisible(), focused: win.isFocused(), minimized: win.isMinimized() };
    },
    openBotId: () => openBotId,
    botName: (botId) => db.getBot(botId)?.name ?? null,
    openBotChat: (botId) => void openBotChatInWindow(botId),
    isMuted: (botId) => db.isMuted('bot', botId), // v1.20
  });
}

/** Restore: the file picked in the Open dialog and checked, waiting for the user's confirm. Main keeps the path. */
let pendingRestore: string | null = null;

function registerIpc(): void {
  // Every handler goes through the lock guard: while locked, only the lock, setup and online:get channels answer.
  const handle = (channel: string, fn: Parameters<typeof ipcMain.handle>[1]): void =>
    ipcMain.handle(channel, lockGuard(channel, isLocked, fn));

  // ---- app lock (v1.13). The passphrase arrives once per call and is never kept, logged or sent on. ----
  handle('lock:state', () => appLock.state());
  handle('lock:unlock', async (_e, passphrase: unknown) => appLock.unlock(passphrase));
  handle('lock:enable', async (_e, passphrase: unknown, confirm: unknown) => { await appLock.enable(passphrase, confirm); return appLock.state(); });
  handle('lock:change', async (_e, current: unknown, passphrase: unknown, confirm: unknown) => appLock.change(current, passphrase, confirm));
  handle('lock:disable', async (_e, current: unknown) => appLock.disable(current));

  // ---- backup and restore (v1.13): local files the user picks; no network. ----
  handle('data:backup', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = {
      title: 'Back up Cipher Bot',
      defaultPath: path.join(app.getPath('documents'), backupFileName(new Date())),
      filters: [{ name: 'Cipher Bot backup', extensions: ['db'] }],
    };
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return { ok: false as const, canceled: true as const };
    if (path.resolve(r.filePath) === path.resolve(dbPath())) return { ok: false as const, error: 'Choose a different file than Cipher Bot\'s own database.' };
    try {
      await db.backup(r.filePath);
      return { ok: true as const, path: r.filePath };
    } catch (err) {
      return { ok: false as const, error: `Could not save the backup: ${err instanceof Error ? err.message : String(err)}` };
    }
  });
  handle('data:restorePick', async (e) => {
    pendingRestore = null;
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = {
      title: 'Restore Cipher Bot from a backup',
      defaultPath: app.getPath('documents'),
      filters: [{ name: 'Cipher Bot backup', extensions: ['db'] }, { name: 'All files', extensions: ['*'] }],
      properties: ['openFile' as const],
    };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (r.canceled || !r.filePaths[0]) return { ok: false as const, canceled: true as const };
    const check = validateBackupFile(r.filePaths[0]);
    if (!check.ok) return { ok: false as const, error: check.error };
    pendingRestore = r.filePaths[0];
    return { ok: true as const, file: path.basename(r.filePaths[0]), bots: check.bots, rooms: check.rooms };
  });
  handle('data:restoreConfirm', async () => {
    const source = pendingRestore;
    pendingRestore = null;
    if (!source) throw new Error('Choose a backup file first.');
    if (activeTurns.size || activeRooms.size) throw new Error('A reply or routine is still running. Try again when it has finished.');
    finishUndo(); // v1.23: a pending delete is purged before the database is replaced
    routines?.stop();
    reminders?.stop();
    phone.stop();
    try {
      await restoreDatabase({ live: db, livePath: dbPath(), source });
    } catch (err) {
      routines?.start();
      reminders?.start();
      throw err;
    }
    // The live database is closed and replaced: restart Cipher on the restored one.
    quitting = true;
    app.relaunch();
    app.exit(0);
  });

  handle('setup:get', () => setup.state);
  handle('setup:start', () => { void setup.run(true); });
  handle('setup:check', () => { void setup.run(false); });
  // Opens the engine's download page. Allowed even when Online is off (user-clicked setup path).
  handle('engine:openDownloadPage', () => {
    assertOutboundAllowed(isOnline(), ENGINE_DOWNLOAD_URL);
    return shell.openExternal(ENGINE_DOWNLOAD_URL);
  });

  handle('online:get', () => isOnline());
  handle('online:set', (_e, on: unknown) => {
    const value = Boolean(on);
    db.setSetting(ONLINE_SETTING_KEY, onlineSettingValue(value));
    if (value) setTimeout(() => void maybeCheckForUpdate(), 5_000); // v1.20: a due check runs soon after Online on
    if (!value) killSearch(); // v1.18: Online off stops any search at once, even mid-reply
    return isOnline();
  });
  // v1.18: the user's answer on the confirm card. Only main's own pending ask (its chat and exact query) can get a token.
  handle('search:answer', (_e, id: unknown, ok: unknown) => answerSearchAsk(id, ok));
  // v1.19: local search history (cipher.db), with Clear (rows really deleted).
  handle('search:history', () => db.listSearchHistory());
  handle('search:clearHistory', () => { db.clearSearchHistory(); return db.listSearchHistory(); });
  // v1.19: open a saved search result's page as text in the chat. Asks first (URL shown); one-time token for that
  // exact URL; Online re-checked at send time and on every hop; public addresses only; text only; size-capped.
  handle('page:open', async (e, chatIdRaw: unknown, url: unknown) => {
    const chatId = asId(chatIdRaw);
    if (typeof url !== 'string') throw new Error('Invalid link.');
    assertLinkOpenAllowed(isOnline(), url);
    if (!db.isStoredResultUrl(url)) throw new Error('Only links from search results can be opened.');
    if (isUrlBlocked(url, db.listBlockedSites())) throw new Error('That site is on your blocked-sites list.');
    const target = new URL(url).toString();
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = {
      type: 'question' as const, buttons: ['Cancel', 'Open as text'], defaultId: 1, cancelId: 0, noLink: true,
      title: 'Open page as text', message: 'Open this page as text in the chat?',
      detail: `${target}\n\nCipher Bot will download this one page from the site (the site sees your IP address) and keep only its text. Nothing on the page runs or loads.`,
    };
    const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
    if (r.response !== 1) return { ok: false as const, canceled: true as const };
    if (!isOnline() || isLocked()) throw new Error('Online is off, so pages cannot be opened.');
    const token = pageConsent.issue(chatId, target);
    const controller = new AbortController();
    activeSearches.add(controller);
    try {
      const page = await fetchPageText(target, {
        isOnline: () => isOnline() && !isLocked(),
        consumeConsent: (u) => pageConsent.consume(token, chatId, u),
        isBlocked: (u) => isUrlBlocked(u, db.listBlockedSites()),
        signal: controller.signal,
      });
      const message = db.addMessage({ chatId, role: 'user', content: formatPageBlock(page) });
      broadcastChat({ chatId, type: 'message', message });
      return { ok: true as const, message };
    } finally {
      activeSearches.delete(controller);
    }
  });
  // v1.19: a bot's memory note (local; in its system prompt every chat). '' clears it.
  handle('bots:setMemory', (_e, botId: unknown, note: unknown) => db.setBotMemory(asId(botId), note));
  // v1.19: delete chosen messages of one chat, after one confirm.
  handle('messages:delete', async (e, chatIdRaw: unknown, ids: unknown) => {
    const chatId = asId(chatIdRaw);
    if (!Array.isArray(ids) || !ids.length) return { deleted: 0 };
    if (activeTurns.has(chatId)) throw new Error('Wait for the reply to finish first.');
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = {
      type: 'warning' as const, buttons: ['Cancel', 'Delete'], defaultId: 0, cancelId: 0, noLink: true,
      title: 'Delete messages', message: `Delete ${ids.length} message${ids.length === 1 ? '' : 's'}?`, detail: 'You can undo this for 10 seconds; then it is deleted for good.',
    };
    const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
    if (r.response !== 1) return { deleted: 0, canceled: true };
    const undoId = beginUndo();
    const deleted = db.softDeleteMessages(chatId, ids, undoId);
    return { deleted, undoId: deleted ? undoId : undefined };
  });
  handle('search:pending', () => [...pendingSearchAsks].map(([id, a]) => ({ id, chatId: a.chatId, query: a.query })));
  handle('search:last', () => db.getSetting(LAST_SEARCH_KEY));
  // v1.18: a source link from a stored search result opens in the system browser, on click only (http/https, Online on).
  // v1.19: links in chat text (markdown) use the same check, plus a confirm showing the URL.
  handle('link:open', async (e, url: unknown, confirm: unknown) => {
    if (typeof url !== 'string') throw new Error('Invalid link.');
    assertLinkOpenAllowed(isOnline(), url);
    if (!db.isStoredResultUrl(url)) throw new Error('Only links from search results can be opened.');
    if (isUrlBlocked(url, db.listBlockedSites())) throw new Error('That site is on your blocked-sites list.');
    if (confirm === true) {
      const win = BrowserWindow.fromWebContents(e.sender);
      const opts = { type: 'question' as const, buttons: ['Cancel', 'Open in browser'], defaultId: 1, cancelId: 0, noLink: true,
        title: 'Open link', message: 'Open this link in your web browser?', detail: url };
      const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
      if (r.response !== 1) return;
      if (!isOnline()) throw new Error('Online is off. Turn it on in Settings to open this link.');
    }
    await shell.openExternal(url);
  });

  handle('phone:get', () => phone.status());
  handle('phone:start', () => phone.start());
  handle('phone:stop', () => phone.stop());
  handle('phone:refreshCode', () => {
    if (!phone.status().running) return phone.start();
    return phone.refreshPairingCode();
  });

  ipcMain.on('ui:openBot', (_e, botId: unknown) => { if (isLocked()) return; openBotId = Number.isSafeInteger(botId) && (botId as number) > 0 ? (botId as number) : null; });
  ipcMain.on('ui:openRoom', (_e, roomId: unknown) => { if (isLocked()) return; openRoomId = Number.isSafeInteger(roomId) && (roomId as number) > 0 ? (roomId as number) : null; });
  handle('unread:clear', (_e, kind: unknown, id: unknown) => {
    if (kind !== 'bot' && kind !== 'room') throw new Error('Invalid kind.');
    db.setUnread(kind, asId(id), false);
  });
  // v1.16: the one source of the version shown in Settings and About.
  handle('app:version', () => app.getVersion());
  handle('sound:get', () => parseSendSound(db.getSetting(SEND_SOUND_SETTING_KEY)));
  handle('sound:set', (_e, on: unknown) => {
    db.setSetting(SEND_SOUND_SETTING_KEY, on === true ? '1' : '0');
    return parseSendSound(db.getSetting(SEND_SOUND_SETTING_KEY));
  });
  handle('bots:list', () => db.listBots());
  handle('bots:create', (_e, input: NewBotForm) => db.createBot(toNewBot(input)));
  handle('bots:update', (_e, botId: unknown, input: unknown) =>
    db.updateBot(asId(botId), formToProfile((input && typeof input === 'object' ? input : {}) as Partial<NewBotForm>)));
  handle('routines:get', (_e, botId: unknown) => db.getRoutine(asId(botId)));
  handle('routines:set', (_e, botId: unknown, input: unknown) =>
    db.setRoutine(asId(botId), (input && typeof input === 'object' ? input : {}) as Record<string, unknown>));
  handle('bots:setFolder', (_e, botId: unknown, folder: unknown) => db.setBotFolder(asId(botId), asFolder(folder)));
  handle('bots:setSecondFolder', (_e, botId: unknown, folder: unknown) => {
    const id = asId(botId);
    const second = asFolder(folder);
    if (second !== null && second === db.getBot(id)?.folderPath) throw new Error('Choose a different folder than this Cipher bot\'s read folder.');
    return db.setBotSecondFolder(id, second);
  });
  handle('bots:setTools', (_e, botId: unknown, enabled: unknown) => db.setBotTools(asId(botId), Boolean(enabled)));
  // Delete (after the UI confirm): refused while the bot or room is replying.
  handle('bots:delete', (_e, botIdRaw: unknown) => {
    const botId = asId(botIdRaw);
    assertBotDeletable(db, botId, activeTurns.keys(), activeRooms.keys());
    const undoId = beginUndo();
    return { ...db.softDeleteBot(botId, undoId), undoId };
  });
  handle('rooms:delete', (_e, roomIdRaw: unknown) => {
    const roomId = asId(roomIdRaw);
    assertRoomDeletable(roomId, activeRooms.keys());
    const undoId = beginUndo();
    db.softDeleteRoom(roomId, undoId);
    return { undoId };
  });
  // Right-click on a bot or room in the left column: a native context menu with "Delete…".
  handle('menu:item', (e, kind: unknown) => new Promise<'delete' | 'archive' | null>((resolve) => {
    if (kind !== 'bot' && kind !== 'room') { resolve(null); return; }
    const menu = Menu.buildFromTemplate([
      { label: kind === 'room' ? 'Archive room' : 'Archive Cipher bot', click: () => resolve('archive') },
      { label: kind === 'room' ? 'Delete room…' : 'Delete Cipher bot…', click: () => resolve('delete') },
    ]);
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    // The close callback can arrive before the item's click on some platforms; give the click a moment to win.
    menu.popup({ window: win, callback: () => { setTimeout(() => resolve(null), 150); } });
  }));

  handle('dialog:pickFolder', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = { title: 'Choose a folder this Cipher bot may read', properties: ['openDirectory' as const] };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (r.canceled || !r.filePaths[0]) return null;
    pickedFolders.add(r.filePaths[0]);
    return r.filePaths[0];
  });

  /**
   * Desktop-only attach: open a file picker (defaulting to the bot's folder), then read through
   * the same read_file sandbox. Rejects paths outside the folder (incl. .. and symlink escape).
   */
  handle('dialog:pickAttachFile', async (e, botIdRaw: unknown) => {
    const bot = db.getBot(asId(botIdRaw));
    if (!bot?.folderPath) return attachFromPath(bot, null);
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = {
      title: 'Attach a text file from this Cipher bot\'s folder',
      defaultPath: bot.folderPath,
      properties: ['openFile' as const],
    };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (r.canceled || !r.filePaths[0]) return { ok: false as const, error: 'No file selected.' };
    return attachFromPath(bot, r.filePaths[0]);
  });
  // v1.17: a file dropped on a bot's chat goes through exactly the same checks as Attach (attachFromPath).
  handle('attach:dropped', (_e, botIdRaw: unknown, filePath: unknown) => {
    const bot = db.getBot(asId(botIdRaw));
    if (typeof filePath !== 'string' || !filePath) return { ok: false as const, error: 'Only files from this computer can be attached.' };
    return attachFromPath(bot, filePath);
  });
  // ---- v1.23 ----
  // Tool switches: only this desktop handler changes them (the phone has no route; a bot's reply can't reach it).
  handle('bots:setToolSwitches', (_e, botId: unknown, update: unknown) => db.setToolSwitches(asId(botId), parseToolUpdate(update)));
  handle('undo:delete', (_e, id: unknown) => undoDelete(id));
  // A pasted screenshot: bytes from the clipboard, checked here like a dropped image (real PNG/JPEG/GIF/WebP, 5 MB),
  // kept in cipher.db (never written into the bot's folder) and shown only as a data: URL built from those bytes.
  handle('image:pasted', (_e, chatIdRaw: unknown, raw: unknown) => {
    const chatId = asId(chatIdRaw);
    const chat = db.getChat(chatId);
    if (!chat || !db.getBot(chat.botId)) throw new Error('Chat not found.');
    if (!(raw instanceof Uint8Array)) return { ok: false as const, error: 'Only images can be pasted.' };
    if (raw.byteLength > MAX_IMAGE_BYTES) return { ok: false as const, error: 'That image is larger than 5 MB.' };
    const bytes = Buffer.from(raw);
    const mime = sniffImage(bytes);
    if (!mime) return { ok: false as const, error: 'Only PNG, JPEG, GIF and WebP images can be pasted.' };
    db.purgeUnsentPastedImages(chatId); // one unsent paste per chat
    const id = db.addPastedImage(chatId, mime, bytes);
    return { ok: true as const, relPath: `pasted:${id}`, dataUrl: toDataUrl(mime, bytes) };
  });
  handle('image:discardPasted', (_e, chatIdRaw: unknown) => { db.purgeUnsentPastedImages(asId(chatIdRaw)); });
  handle('reminders:list', (_e, botId: unknown) => db.listReminders(asId(botId)));
  handle('reminders:add', (_e, botId: unknown, at: unknown, prompt: unknown) => { db.addReminder(asId(botId), at, prompt); return db.listReminders(asId(botId)); });
  handle('reminders:delete', (_e, botId: unknown, id: unknown) => db.deleteReminder(asId(botId), asId(id)));
  handle('disk:usage', () => diskUsage({
    dbPath: dbPath(),
    folders: db.listBots().flatMap((b) => [b.folderPath, b.secondFolderPath]).filter((f): f is string => !!f),
  }));
  // v1.22: one tap saves a message's text into its bot's memory note (refused clearly when the note is full).
  handle('memory:remember', (_e, chatIdRaw: unknown, idRaw: unknown) => {
    const chatId = asId(chatIdRaw);
    const chat = db.getChat(chatId);
    const m = chat ? db.getMessage(chatId, asId(idRaw)) : null;
    if (!chat || !m) throw new Error('That message is gone.');
    return db.appendBotMemory(chat.botId, m.content);
  });
  // v1.22: the checklist (user actions; a bot can only add through actionHooks.addChecklist and its native confirm).
  handle('checklist:list', (_e, botId: unknown) => db.listChecklist(asId(botId)));
  handle('checklist:add', (_e, botId: unknown, text: unknown) => db.addChecklistItem(asId(botId), text));
  handle('checklist:done', (_e, botId: unknown, itemId: unknown, done: unknown) => db.setChecklistDone(asId(botId), asId(itemId), done === true));
  handle('checklist:delete', (_e, botId: unknown, itemId: unknown) => db.deleteChecklistItem(asId(botId), asId(itemId)));
  handle('accent:get', () => parseAccent(db.getSetting(ACCENT_KEY)));
  handle('accent:set', (_e, a: unknown) => { const v = parseAccent(a); db.setSetting(ACCENT_KEY, v); return v; });
  handle('prefs:get', () => readUiPrefs((k) => db.getSetting(k)));
  handle('prefs:set', (_e, name: unknown, value: unknown) => {
    if (!isUiPrefName(name)) throw new Error('Unknown setting.');
    db.setSetting(UI_PREFS[name].key, value === true ? '1' : '0');
    return readUiPrefs((k) => db.getSetting(k));
  });

  // One chat per bot: its most recent chat, created on first open. Older chats stay in the database, hidden.
  handle('chats:openForBot', (_e, botId: unknown) => db.getBotChat(asId(botId)));
  handle('messages:list', (_e, chatId: unknown) => db.listMessages(asId(chatId)));
  // Clear chat (after the UI confirm): deletes only this bot's 1:1 chat messages. Not while it's replying.
  handle('chats:clearForBot', (_e, botIdRaw: unknown) => {
    const botId = asId(botIdRaw);
    if (activeTurns.has(db.getBotChat(botId).id)) throw new Error('This chat is still replying.');
    const undoId = beginUndo();
    db.softClearBotChat(botId, undoId);
    return { ...db.getBotChat(botId), undoId };
  });
  handle('clipboard:writeText', (_e, text: unknown) => {
    if (typeof text !== 'string') throw new Error('Nothing to copy.');
    if (text.length > MAX_COPY_CHARS) throw new Error('This message is too long to copy.');
    clipboard.writeText(text);
  });
  // Export the open chat or room: native Save dialog, then a local plain-text file. No network.
  handle('chat:export', async (e, kind: unknown, idRaw: unknown) => {
    const { name, text } = chatExport(kind, asId(idRaw));
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = {
      title: 'Export chat',
      defaultPath: path.join(app.getPath('documents'), exportFileName(name)),
      filters: [{ name: 'Text file', extensions: ['txt'] }],
    };
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return { ok: false as const, canceled: true as const };
    try {
      await fs.writeFile(r.filePath, text, 'utf8');
      return { ok: true as const, path: r.filePath };
    } catch (err) {
      return { ok: false as const, error: `Could not save the file: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  handle('chat:send', async (_e, chatIdRaw: unknown, text: unknown, extrasRaw: unknown) => {
    const chatId = asId(chatIdRaw);
    if (typeof text !== 'string' || !text.trim()) throw new Error('Message is empty.');
    if (activeTurns.has(chatId)) throw new Error('This chat is still replying.');
    const extras = await sendExtras(chatId, extrasRaw);
    if (activeTurns.has(chatId)) throw new Error('This chat is still replying.');
    const controller = new AbortController();
    activeTurns.set(chatId, controller);
    void beginChatTurn(chatId, text, broadcastChat, controller.signal, false, extras)
      .catch((err: unknown) => broadcastChat({ chatId, type: 'error', error: err instanceof Error ? err.message : String(err) }))
      .finally(() => { activeTurns.delete(chatId); noteReplyFinished(botOfChat(chatId), controller.signal.aborted); });
  });
  handle('chat:stop', (_e, chatId: unknown) => { activeTurns.get(asId(chatId))?.abort(); });

  // ---- v1.25: drafts, voice, weekly report ----
  handle('drafts:list', (_e, chatId: unknown) => drafts.list(asId(chatId)).map((d) => ({ id: d.id, path: d.path, content: d.content, createdAt: d.createdAt })));
  handle('drafts:discard', (_e, chatId: unknown, id: unknown) => { const ok = drafts.discard(id, asId(chatId)); sendToWindow('drafts:changed', asId(chatId)); return ok; });
  handle('drafts:save', async (_e, chatIdRaw: unknown, id: unknown) => {
    const chatId = asId(chatIdRaw);
    const chat = db.getChat(chatId);
    const bot = chat ? db.getBot(chat.botId) : null;
    if (!bot || !drafts.get(id, chatId)) throw new Error('That draft is gone.');
    // Switches checked again now: Files and Write file on, a folder set.
    if (!toolSwitches(bot).files || !toolSwitches(bot).write || !bot.folderPath) throw new Error('Turn on Files and Write file (plus menu → Tools) and choose a folder to save drafts.');
    const d = drafts.take(id, chatId)!;
    sendToWindow('drafts:changed', chatId);
    // The v1.22 path: native confirm in main → one-time token → commitWrite. Nothing is written before that.
    const r = await confirmAndWrite({ consent: writeConsent, isLocked, ask: (t) => nativeAsk('Save draft', t) }, chatId, bot.name, bot.folderPath, d.path, d.content);
    if (!r.ok && /cancel/i.test(r.content)) { drafts.add(chatId, bot.id, d.path, d.content); sendToWindow('drafts:changed', chatId); }
    broadcastChat({ chatId, type: 'message', message: db.addMessage({ chatId, role: 'tool', content: r.content, toolName: 'write_file' }) });
    return { ok: r.ok, content: r.content };
  });
  const voiceState = () => ({ engine: db.getSetting(VOICE_ENGINE_KEY) || null, model: db.getSetting(VOICE_MODEL_KEY) || null, tested: WHISPER_TESTED_VERSION });
  const pickFile = async (e: Electron.IpcMainInvokeEvent, title: string, filters?: { name: string; extensions: string[] }[]): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = { title, properties: ['openFile' as const], ...(filters ? { filters } : {}) };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  };
  handle('voice:state', () => voiceState());
  handle('voice:pickEngine', async (e) => { const f = await pickFile(e, 'Choose whisper-cli (whisper.cpp)'); if (f) db.setSetting(VOICE_ENGINE_KEY, await checkEngine(f)); return voiceState(); });
  handle('voice:pickModel', async (e) => { const f = await pickFile(e, 'Choose a whisper.cpp model', [{ name: 'whisper.cpp model', extensions: ['bin'] }]); if (f) db.setSetting(VOICE_MODEL_KEY, await checkModel(f)); return voiceState(); });
  handle('voice:clear', () => { db.setSetting(VOICE_ENGINE_KEY, ''); db.setSetting(VOICE_MODEL_KEY, ''); return voiceState(); });
  handle('voice:transcribe', async (_e, pcm: unknown) => transcribe({ engine: db.getSetting(VOICE_ENGINE_KEY), model: db.getSetting(VOICE_MODEL_KEY), pcm }));
  const weekly = async (): Promise<string> => {
    const now = new Date();
    const since = weekStart(now).toISOString();
    const folder = db.getSetting(BACKUP_FOLDER_KEY);
    let inFolder: number | null = null;
    if (folder) { try { inFolder = (await fs.readdir(folder)).filter((n) => /^cipher-backup-.*\.db$/.test(n)).length; } catch { inFolder = null; } }
    return formatWeeklyReport({ since, until: now.toISOString(), ...db.weeklyCounts(since),
      backups: { scheduled: parseSchedule(db.getSetting(BACKUP_SCHEDULE_KEY)), last: db.getSetting(BACKUP_LAST_KEY) || null, inFolder } });
  };
  handle('report:weekly', () => weekly());
  handle('report:save', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = { title: 'Save weekly report', defaultPath: path.join(app.getPath('documents'), `cipher-weekly-${new Date().toISOString().slice(0, 10)}.txt`), filters: [{ name: 'Text file', extensions: ['txt'] }] };
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return { ok: false as const, canceled: true as const };
    await fs.writeFile(r.filePath, await weekly(), 'utf8');
    return { ok: true as const, path: r.filePath };
  });

  // ---- v1.24 ----
  const pickFolder = async (e: Electron.IpcMainInvokeEvent, title: string): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = { title, properties: ['openDirectory' as const, 'createDirectory' as const] };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  };
  // Shared folder: app-wide, read-only, only read by a bot whose Files switch is on (checked at offer and run).
  handle('shared:get', () => sharedFolder());
  handle('shared:pick', async (e) => {
    const f = await pickFolder(e, 'Choose the shared folder');
    if (f) db.setSetting(SHARED_FOLDER_KEY, await fs.realpath(f));
    return sharedFolder();
  });
  handle('shared:clear', () => { db.setSetting(SHARED_FOLDER_KEY, ''); return null; });
  // Lock timeout, tokens per second, font.
  handle('locktimeout:get', () => parseLockTimeout(db.getSetting(LOCK_TIMEOUT_KEY)));
  handle('locktimeout:set', (_e, v: unknown) => {
    if (!(LOCK_TIMEOUTS as readonly unknown[]).includes(v)) throw new Error('Unknown lock timeout.');
    db.setSetting(LOCK_TIMEOUT_KEY, v as string); return parseLockTimeout(v);
  });
  handle('tps:get', () => db.getSetting(TPS_KEY) === '1');
  handle('tps:set', (_e, on: unknown) => { db.setSetting(TPS_KEY, on === true ? '1' : '0'); return on === true; });
  handle('font:get', () => parseFont(db.getSetting(FONT_KEY)));
  handle('font:set', (_e, v: unknown) => {
    if (!(FONTS as readonly unknown[]).includes(v)) throw new Error('Unknown font.');
    db.setSetting(FONT_KEY, v as string); return parseFont(v);
  });
  // Reactions, edits, activity, tags, dock folders.
  handle('messages:react', (_e, chatId: unknown, id: unknown, r: unknown) => db.setReaction(asId(chatId), asId(id), parseReaction(r)));
  handle('messages:edit', (_e, chatId: unknown, id: unknown, text: unknown) => {
    if (activeTurns.has(asId(chatId))) throw new Error('This chat is still replying.');
    return db.editMessage(asId(chatId), asId(id), text);
  });
  handle('messages:edits', (_e, chatId: unknown, id: unknown) => db.listMessageEdits(asId(chatId), asId(id)));
  handle('bots:activity', (_e, botId: unknown) => db.botActivity(asId(botId)));
  handle('bots:setTags', (_e, botId: unknown, tags: unknown) => db.setBotTags(asId(botId), normalizeTags(tags)));
  handle('bots:setGroup', (_e, botId: unknown, g: unknown) => db.setBotGroup(asId(botId), normalizeGroup(g)));
  handle('dock:groupsCollapsed', () => {
    try { const v = JSON.parse(db.getSetting(DOCK_GROUPS_COLLAPSED_KEY) ?? '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 100) : []; } catch { return []; }
  });
  handle('dock:setGroupsCollapsed', (_e, list: unknown) => {
    const v = Array.isArray(list) ? [...new Set(list.map(normalizeGroup).filter(Boolean))].slice(0, 100) : [];
    db.setSetting(DOCK_GROUPS_COLLAPSED_KEY, JSON.stringify(v)); return v;
  });
  // Reminder from one line of text.
  handle('reminders:import', (_e, botId: unknown, line: unknown) => {
    const { at, prompt } = parseReminderLine(line);
    db.addReminder(asId(botId), at, prompt);
    return db.listReminders(asId(botId));
  });
  // Summarize a folder: native confirm in main, one-time token, Files switch re-checked before reading.
  handle('folder:summarize', async (_e, chatIdRaw: unknown) => {
    const chatId = asId(chatIdRaw);
    if (activeTurns.has(chatId)) throw new Error('This chat is still replying.');
    const botId = botOfChat(chatId);
    const text = await confirmFolderSummary({
      consent: summaryConsent, isLocked, ask: (t) => nativeAsk('Summarize folder', t),
      bot: () => { const b = botId === null ? null : db.getBot(botId.id); return b ? { name: b.name, folderPath: b.folderPath, filesOn: b.toolsEnabled } : null; },
    }, chatId);
    if (!text) return { ok: false as const, canceled: true as const };
    if (activeTurns.has(chatId)) throw new Error('This chat is still replying.');
    const controller = new AbortController();
    activeTurns.set(chatId, controller);
    void beginChatTurn(chatId, text, broadcastChat, controller.signal, false)
      .catch((err: unknown) => broadcastChat({ chatId, type: 'error', error: err instanceof Error ? err.message : String(err) }))
      .finally(() => { activeTurns.delete(chatId); noteReplyFinished(botOfChat(chatId), controller.signal.aborted); });
    return { ok: true as const };
  });
  // Scheduled backup: a local folder picked in a native dialog; warns on network/cloud mounts. No network.
  const backupState = () => ({
    schedule: parseSchedule(db.getSetting(BACKUP_SCHEDULE_KEY)), folder: db.getSetting(BACKUP_FOLDER_KEY) || null,
    last: db.getSetting(BACKUP_LAST_KEY) || null,
  });
  handle('backupsched:get', () => backupState());
  handle('backupsched:set', (_e, v: unknown) => {
    if (!(BACKUP_SCHEDULES as readonly unknown[]).includes(v)) throw new Error('Unknown schedule.');
    if (v !== 'off' && !db.getSetting(BACKUP_FOLDER_KEY)) throw new Error('Choose a backup folder first.');
    db.setSetting(BACKUP_SCHEDULE_KEY, v as string); return backupState();
  });
  handle('backupsched:pick', async (e) => {
    const f = await pickFolder(e, 'Choose a folder for backups');
    if (!f) return backupState();
    const dir = await checkBackupFolder(f);
    const mount = isNetworkFolder(dir);
    if (mount.network) {
      const ok = await nativeAsk('Backup folder', {
        message: 'That folder looks like a network or cloud drive.',
        detail: `${dir}\nFile system: ${mount.fstype ?? 'network share'}\n\nBackups hold all your chats. Saving them there copies them off this computer. Use it anyway?`,
        buttons: ['Cancel', 'Use this folder'],
      });
      if (ok !== 1) return backupState();
    }
    db.setSetting(BACKUP_FOLDER_KEY, dir);
    return backupState();
  });
  // Settings file: never chats or lock data; memory notes only if the user opts in.
  handle('settings:export', async (e, includeMemory: unknown) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = { title: 'Export settings', defaultPath: path.join(app.getPath('documents'), 'cipher-bot-settings.json'), filters: [{ name: 'Settings', extensions: ['json'] }] };
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return { ok: false as const, canceled: true as const };
    await fs.writeFile(r.filePath, buildSettingsExport((k) => db.getSetting(k), app.getVersion(), includeMemory === true ? db.memoryNotes() : null), 'utf8');
    return { ok: true as const, path: r.filePath };
  });
  handle('settings:import', async (e, includeMemory: unknown) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = { title: 'Import settings', properties: ['openFile' as const], filters: [{ name: 'Settings', extensions: ['json'] }] };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (r.canceled || !r.filePaths[0]) return { ok: false as const, canceled: true as const };
    const st = await fs.stat(r.filePaths[0]);
    if (st.size > 16 * 1024) throw new Error('That is not a Cipher Bot settings file (too large).');
    const text = await fs.readFile(r.filePaths[0], 'utf8');
    const items = parseSettingsImport(text);
    for (const { key, value } of items) db.setSetting(key, value);
    let memory = 0;
    if (includeMemory === true) {
      const bots = db.listBots();
      for (const m of parseMemoryImport(text, MEMORY_NOTE_MAX)) {
        const b = bots.find((x) => x.name === m.bot);
        if (b) { db.setBotMemory(b.id, m.note); memory++; }
      }
    }
    return { ok: true as const, applied: items.length, memory };
  });

  // ---- v1.20: quote, pin, mute, dropped images ----
  handle('messages:pin', (_e, chatIdRaw: unknown, idRaw: unknown, on: unknown) => db.setPinned(asId(chatIdRaw), asId(idRaw), on === true));
  handle('messages:pinned', (_e, chatIdRaw: unknown) => db.listPinned(asId(chatIdRaw)));
  // ---- v1.21: archive, reply length, blocked sites, always on top, first-run tips ----
  handle('archive:set', (_e, kind: unknown, idRaw: unknown, on: unknown) => {
    if (kind !== 'bot' && kind !== 'room') throw new Error('Unknown kind.');
    const id = asId(idRaw);
    if (on === true && kind === 'bot' && activeTurns.has(db.getBotChat(id).id)) throw new Error('This chat is still replying.');
    if (on === true && kind === 'room' && activeRooms.has(id)) throw new Error('This room is still replying.');
    db.setArchived(kind, id, on === true);
    return { bots: db.listBots(), rooms: db.listRooms() };
  });
  handle('bots:setReplyLength', (_e, idRaw: unknown, value: unknown) => db.setReplyLength(asId(idRaw), value));
  handle('sites:list', () => db.listBlockedSites());
  handle('sites:add', (_e, site: unknown) => db.addBlockedSite(site));
  handle('sites:remove', (_e, site: unknown) => db.removeBlockedSite(site));
  handle('window:getAlwaysOnTop', () => isAlwaysOnTop());
  handle('window:setAlwaysOnTop', (_e, on: unknown) => setAlwaysOnTop(on === true));
  handle('tips:get', () => db.getSetting(TIPS_SEEN_KEY) !== '1');
  handle('tips:done', () => { db.setSetting(TIPS_SEEN_KEY, '1'); });
  // v1.21: a bot's chat as Markdown; v1.22: rooms too (kind 'room'). Clipboard only.
  handle('chat:markdown', (_e, a: unknown, b: unknown) => {
    const kind = a === 'room' || a === 'bot' ? a : 'bot';
    const id = asId(a === 'room' || a === 'bot' ? b : a);
    let text: string;
    if (kind === 'room') {
      const room = db.getRoom(id);
      if (!room) throw new Error('Room not found.');
      const nameOf = (botId: number | null) => (botId === null ? null : db.getBot(botId)?.name ?? null);
      const name = room.name.trim() || room.memberIds.map((x) => nameOf(x)).filter((n): n is string => !!n).join(', ') || 'Room';
      text = roomMarkdown(name, db.listRoomMessages(id), nameOf);
    } else {
      const bot = db.getBot(id);
      if (!bot) throw new Error('Cipher bot not found.');
      text = chatMarkdown(bot.name, db.listMessages(db.getBotChat(bot.id).id));
    }
    if (text.length > MAX_COPY_CHARS) throw new Error('This chat is too long to copy.');
    clipboard.writeText(text);
    return { chars: text.length };
  });
  handle('mute:set', (_e, kind: unknown, idRaw: unknown, on: unknown) => {
    if (kind !== 'bot' && kind !== 'room') throw new Error('Unknown kind.');
    db.setMuted(kind, asId(idRaw), on === true);
    return db.isMuted(kind, asId(idRaw));
  });
  handle('image:dropped', (_e, botIdRaw: unknown, filePath: unknown) => {
    if (typeof filePath !== 'string' || !filePath || !isImagePath(filePath)) return { ok: false as const, error: 'Only PNG, JPEG, GIF and WebP images can be shown.' };
    return attachImageFromPath(db.getBot(asId(botIdRaw)), filePath);
  });
  // The bubble's picture: re-read from the bot's folder under the same rules each time, returned as a data: URL.
  handle('image:get', async (_e, chatIdRaw: unknown, idRaw: unknown) => {
    const chatId = asId(chatIdRaw);
    const m = db.getMessage(chatId, asId(idRaw));
    const chat = db.getChat(chatId);
    const bot = chat ? db.getBot(chat.botId) : null;
    if (!m?.image || !bot) return null;
    if (m.image.startsWith('pasted:')) {
      const p = db.getPastedImage(chatId, Number(m.image.slice(7)));
      const mime = p ? sniffImage(p.bytes) : null;
      return p && mime ? toDataUrl(mime, p.bytes) : null;
    }
    try {
      const img = await readImageInFolder(bot.folderPath, m.image);
      return toDataUrl(img.mime, img.bytes);
    } catch {
      return null;
    }
  });

  // ---- v1.20: update check state and the confirmed download (desktop only; the phone has no route to these) ----
  handle('update:get', () => updateState());
  handle('update:download', async (e) => {
    const info = availableUpdate;
    if (!info) throw new Error('No update to download.');
    if (!isOnline()) throw new Error('Turn Online on to download the update.');
    if (updateController) throw new Error('An update check or download is already running.');
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = {
      type: 'question' as const, buttons: ['Cancel', 'Download'], defaultId: 1, cancelId: 0, noLink: true,
      title: 'Download update', message: `Download Cipher Bot ${info.version} from GitHub?`,
      detail: `${info.name} (${(info.size / 1048576).toFixed(1)} MB) will be saved to your Downloads folder. Cipher Bot does not install it; open it yourself when you are ready.`,
    };
    const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
    if (r.response !== 1 || !isOnline()) return updateState();
    const controller = new AbortController();
    updateController = controller;
    updateStatus = { ...updateStatus, downloading: true, done: 0, error: null, savedTo: null };
    pushUpdateState();
    let last = 0;
    try {
      updateStatus.savedTo = await downloadUpdate(info, app.getPath('downloads'), {
        isOnline, signal: controller.signal,
        onProgress: (done) => { updateStatus.done = done; if (Date.now() - last > 250) { last = Date.now(); pushUpdateState(); } },
      });
    } catch (err) {
      updateStatus.error = controller.signal.aborted ? 'Online was turned off; the download was stopped.' : err instanceof Error ? err.message : String(err);
    } finally {
      if (updateController === controller) updateController = null;
      updateStatus.downloading = false;
      pushUpdateState();
    }
    return updateState();
  });
  handle('update:showFile', () => { if (updateStatus.savedTo) shell.showItemInFolder(updateStatus.savedTo); });

  // ---- v1.20: export a debug log (local file via Save dialog; chat content only when the box is ticked) ----
  handle('debug:export', async (e, includeChats: unknown) => {
    const bots = db.listBots();
    const rooms = db.listRooms();
    const chats = includeChats === true
      ? [...bots.flatMap((b) => db.listChats(b.id).map((c) => ({ title: `${b.name}: ${c.title}`, messages: db.listMessages(c.id).map((m) => ({ role: m.role, content: m.content, createdAt: m.createdAt })) }))),
         ...rooms.map((r) => ({ title: `Room ${r.name}`, messages: db.listRoomMessages(r.id).map((m) => ({ role: m.role, content: m.content, createdAt: m.createdAt })) }))]
      : undefined;
    const text = buildDebugLog({
      appVersion: app.getVersion(), electron: process.versions.electron ?? '', chrome: process.versions.chrome ?? '', node: process.versions.node,
      platform: process.platform, arch: process.arch, osRelease: os.release(), schemaVersion: SCHEMA_VERSION, model: currentModel(),
      online: isOnline(), locked: isLocked(), lockEnabled: appLock.state().enabled, phoneRunning: phone.status().running,
      setupPhase: setup.state.phase,
      counts: { bots: bots.length, rooms: rooms.length, routines: db.listRoutines().length, 'bots with a folder': bots.filter((b) => b.folderPath).length, 'muted bots': bots.filter((b) => b.muted).length },
      prefs: readPrefsForLog((k) => db.getSetting(k)), lastUpdateCheck: db.getSetting(UPDATE_LAST_CHECK_KEY),
    }, recentLogLines(), chats);
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = { title: 'Export debug log', defaultPath: path.join(app.getPath('documents'), `cipher-bot-debug-${new Date().toISOString().slice(0, 10)}.txt`), filters: [{ name: 'Text file', extensions: ['txt'] }] };
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return { ok: false as const, canceled: true as const };
    try {
      await fs.writeFile(r.filePath, text, 'utf8');
      return { ok: true as const, path: r.filePath };
    } catch (err) {
      return { ok: false as const, error: `Could not save the file: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  // ---- rooms (group chats). No tools in rooms; see roomEngine.ts. ----
  handle('rooms:list', () => db.listRooms());
  handle('rooms:create', (_e, input: unknown) => {
    const form = (input && typeof input === 'object' ? input : {}) as Partial<NewRoomForm>;
    return db.createRoom({ name: form.name, botIds: form.botIds });
  });
  handle('roomMessages:list', (_e, roomId: unknown) => db.listRoomMessages(asId(roomId)));
  handle('room:send', (e, roomIdRaw: unknown, text: unknown) => {
    const roomId = asId(roomIdRaw);
    if (typeof text !== 'string' || !text.trim()) throw new Error('Message is empty.');
    if (!db.getRoom(roomId)) throw new Error('Room not found.');
    if (activeRooms.has(roomId)) throw new Error('This room is still replying.');
    const controller = new AbortController();
    activeRooms.set(roomId, controller);
    void runRoomTurn({ db, model: currentModel(), emit: broadcastRoom }, roomId, text, controller.signal)
      .catch((err: unknown) => broadcastRoom({ roomId, type: 'error', error: err instanceof Error ? err.message : String(err) }))
      .finally(() => { activeRooms.delete(roomId); noteReplyFinished({ kind: 'room', id: roomId }, controller.signal.aborted); });
  });
  handle('room:stop', (_e, roomId: unknown) => { activeRooms.get(asId(roomId))?.abort(); });
}

function phoneStaticDir(): string {
  // In production/dev after build: dist/phone. Source fallback for tests that point explicitly.
  return path.join(__dirname, '..', 'phone');
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // A second launch shows the existing window (also when it's hidden in the tray).
  app.on('second-instance', () => {
    if (app.isReady()) void showWindow();
  });

  app.whenReady().then(() => {
    db = new CipherDb(dbPath());
    // v1.23: anything soft-deleted when Cipher Bot last closed, and pastes never sent, are purged for real now.
    db.purgeDeleted(null);
    db.purgeUnsentPastedImages();
    appLock = new AppLock(new LockStore(app.getPath('userData')));
    // Online defaults off: do not seed '1'. Absence means off.
    lockDownNetwork();
    setup = new SetupManager({ model: currentModel(), onChange: broadcastSetup });
    phoneUnlock = new PhoneUnlock({ record: () => { const r = new LockStore(app.getPath('userData')).read(); return r && r !== 'invalid' ? r : null; } });
    // v1.24: idle lock (Settings → Lock after) and scheduled backups, both checked locally on a timer.
    setInterval(() => {
      if (shouldIdleLock({ enabled: appLock.isEnabled(), locked: appLock.isLocked(), timeout: parseLockTimeout(db.getSetting(LOCK_TIMEOUT_KEY)), idleSeconds: powerMonitor.getSystemIdleTime() })) {
        const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed());
        if (w) void lockApp(w); else appLock.lock();
      }
    }, IDLE_CHECK_MS).unref?.();
    const backupTick = () => {
      const st = parseSchedule(db.getSetting(BACKUP_SCHEDULE_KEY));
      if (!isBackupDue(st, db.getSetting(BACKUP_LAST_KEY), new Date())) return;
      const now = new Date();
      void runScheduledBackup({ folder: db.getSetting(BACKUP_FOLDER_KEY), now, backup: (dest) => db.backup(dest) })
        .then(() => db.setSetting(BACKUP_LAST_KEY, now.toISOString()))
        .catch((err: unknown) => recordLogLine('warn', [`scheduled backup failed: ${err instanceof Error ? err.message : String(err)}`]));
    };
    setTimeout(backupTick, 60_000).unref?.();
    setInterval(backupTick, BACKUP_CHECK_MS).unref?.();
    phone = new PhoneServer({
      phoneUnlock,
      db,
      staticDir: phoneStaticDir(),
      model: currentModel(),
      isLocked,
      onStatus: () => broadcastPhone(),
      // v1.19: a paired, unlocked phone session may answer a confirm card main put up (same rules as the desktop).
      answerSearch: (id, ok) => answerSearchAsk(id, ok),
      pendingSearches: (chatId) => [...pendingSearchAsks].filter(([, a]) => a.chatId === chatId).map(([id, a]) => ({ id, query: a.query })),
      sendChat: (chatId, text, emit, signal) => {
        // Share abort map with desktop Stop where possible.
        if (activeTurns.has(chatId)) return Promise.reject(new Error('This chat is still replying.'));
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        signal.addEventListener('abort', onAbort, { once: true });
        activeTurns.set(chatId, controller);
        const fanout = (ev: ChatEvent) => { emit(ev); broadcastChat(ev); };
        return beginChatTurn(chatId, text, fanout, controller.signal, true)
          .finally(() => {
            signal.removeEventListener('abort', onAbort);
            activeTurns.delete(chatId);
            noteReplyFinished(botOfChat(chatId), controller.signal.aborted);
          });
      },
      stopChat: (chatId) => { activeTurns.get(chatId)?.abort(); },
      sendRoom: (roomId, text, emit, signal) => {
        if (activeRooms.has(roomId)) return Promise.reject(new Error('This room is still replying.'));
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        signal.addEventListener('abort', onAbort, { once: true });
        activeRooms.set(roomId, controller);
        const fanout = (ev: RoomEvent) => { emit(ev); broadcastRoom(ev); };
        return runRoomTurn({ db, model: currentModel(), emit: fanout }, roomId, text, controller.signal)
          .finally(() => {
            signal.removeEventListener('abort', onAbort);
            activeRooms.delete(roomId);
            noteReplyFinished({ kind: 'room', id: roomId }, controller.signal.aborted);
          });
      },
      stopRoom: (roomId) => { activeRooms.get(roomId)?.abort(); },
    });
    registerIpc();
    routineNotifier = createRoutineNotifier();
    // Daily routines: a main-process timer, only while Cipher runs (window open or in the tray). No OS scheduler.
    routines = new RoutineScheduler({
      listRoutines: () => db.listActiveRoutines(), // v1.21: an archived bot's routine is paused
      chatIdForBot: (botId) => db.getBotChat(botId).id,
      isBusy: (chatId) => activeTurns.has(chatId),
      markRun: (botId, dateKey) => db.markRoutineRun(botId, dateKey),
      run: (botId, chatId, prompt) => runRoutineTurn(botId, chatId, prompt),
    });
    routines.start();
    // v1.23: one-time reminders (main-process timer; missed ones are skipped, never caught up).
    reminders = new ReminderScheduler({
      listPending: () => db.listReminders().filter((x) => x.status === 'pending'),
      bot: (botId) => { const b = db.getBot(botId); return b ? { archived: b.archived } : null; },
      chatIdForBot: (botId) => db.getBotChat(botId).id,
      isBusy: (chatId) => activeTurns.has(chatId),
      setStatus: (id, status, note) => {
        db.setReminderStatus(id, status, note);
        const r = db.listReminders().find((x) => x.id === id);
        if (r) sendToWindow('reminders:changed', r.botId);
      },
      run: (r, chatId) => runReminderTurn(r, chatId),
    });
    reminders.start();
    // v1.20: update check timer. Nothing goes out unless Online is on (checked when it fires and again before sending).
    setTimeout(() => void maybeCheckForUpdate(), 30_000);
    updateTimer = setInterval(() => void maybeCheckForUpdate(), UPDATE_TIMER_MS);
    createWindow();
    createTray();
    void setup.run(true); // first launch: download the model through the local engine if it's missing
    app.on('activate', () => void showWindow());
  });

  // Any real quit (tray Quit, Ctrl+Q, app.quit) lets the window close instead of hiding.
  app.on('before-quit', () => { quitting = true; });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', () => {
    finishUndo(); // v1.23: a pending delete is purged for real before quitting
    routines?.stop();
    reminders?.stop();
    if (updateTimer) clearInterval(updateTimer);
    killUpdate();
    for (const c of activeTurns.values()) c.abort();
    for (const c of activeRooms.values()) c.abort();
    phone?.stop();
    tray?.destroy();
    tray = null;
    db?.close();
  });
}

// Re-export port for docs/tests.
export { PHONE_LINK_PORT };
