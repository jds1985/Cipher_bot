import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, session, shell, Tray } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ChatEvent, NewBotForm, NewRoomForm, RoomEvent, SetupState } from '../shared/types';
import { CipherDb } from './db';
import { runChatTurn } from './chatEngine';
import { runRoomTurn } from './roomEngine';
import { formToProfile, toNewBot } from './createBot';
import { botChatExportLines, exportFileName, formatChatExport, roomExportLines } from './exportChat';
import { configuredModel, ENGINE_DOWNLOAD_URL } from './ollama';
import { SetupManager } from './setup';
import { ONLINE_SETTING_KEY, assertOutboundAllowed, onlineSettingValue, parseOnlineSetting } from './networkGuard';
import { PhoneServer, PHONE_LINK_PORT } from './phoneServer';
import { readFileForAttach } from './attachFile';
import { ToolError } from './readFileTool';
import { RoutineScheduler } from './routine';

let db: CipherDb;
let setup: SetupManager;
let phone: PhoneServer;
let routines: RoutineScheduler | null = null;
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
  const s = phone.status();
  for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.isDestroyed()) w.webContents.send('phone:status', s);
}

function broadcastChat(ev: ChatEvent): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.isDestroyed()) w.webContents.send('chat:event', ev);
}

function broadcastRoom(ev: RoomEvent): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.isDestroyed()) w.webContents.send('room:event', ev);
}

/** Tray icon (close-to-tray). Null when the tray isn't available: then closing the window quits as before. */
let tray: Tray | null = null;
/** True once a real quit has begun (tray Quit, Ctrl+Q, app.quit from anywhere), so close no longer hides. */
let quitting = false;

const appIconPath = (): string => path.join(__dirname, '..', 'renderer', 'assets', 'icon.png');

/** Show and focus the (possibly hidden or minimized) window, or create it if there is none. */
function showWindow(): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/**
 * Keep Cipher running in the tray when the window is closed. Uses the existing app icon (no new art).
 * Hiding/showing never touches the phone link or the Online setting. If the tray can't be created,
 * tray stays null and closing the window quits as before.
 */
function createTray(): void {
  try {
    const size = process.platform === 'linux' ? 22 : 16;
    const icon = nativeImage.createFromPath(appIconPath());
    if (icon.isEmpty()) return;
    tray = new Tray(icon.resize({ width: size, height: size, quality: 'best' }));
    tray.setToolTip('Cipher');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show Cipher', click: () => showWindow() },
      { type: 'separator' },
      { label: 'Quit', click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on('click', () => showWindow());
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
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
}

/** Cipher window frame colors (match --bg and --accent in styles.css). */
const FRAME_BG = '#15171c';
const FRAME_ACCENT = '#5b8cff';
/**
 * Height of the title strip = Liz's top frame (cipher-frame-top.svg, 40px), so the window controls line up with it.
 * The renderer's #titlebar uses env(titlebar-area-height), falling back to 40px.
 */
const TITLE_BAR_HEIGHT = 40;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 760,
    minHeight: 480,
    resizable: true,
    title: 'Cipher',
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
  win.removeMenu();
  // Close hides to the tray (Cipher keeps running: phone link and replies continue). A real quit closes.
  win.on('close', (e) => {
    if (!quitting && tray && !tray.isDestroyed()) {
      e.preventDefault();
      win.hide();
    }
  });
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
  void win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
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

/** Longest text the copy button will put on the clipboard. */
const MAX_COPY_CHARS = 2_000_000;

/** Start a 1:1 turn shared by desktop IPC and phone link. */
function beginChatTurn(chatId: number, text: string, emit: (e: ChatEvent) => void, signal: AbortSignal, toolsOff: boolean): Promise<void> {
  return runChatTurn({ db, model: currentModel(), emit, forceToolsOff: toolsOff }, chatId, text, signal);
}

/**
 * Run a bot's routine: its saved prompt goes to the bot's chat as a user message marked as from the routine,
 * and the bot replies through the local model as usual. File reading is always off for routine turns.
 */
function runRoutineTurn(chatId: number, prompt: string): void {
  if (activeTurns.has(chatId)) return;
  const controller = new AbortController();
  activeTurns.set(chatId, controller);
  void runChatTurn({ db, model: currentModel(), emit: broadcastChat, forceToolsOff: true, fromRoutine: true }, chatId, prompt, controller.signal)
    .catch((err: unknown) => broadcastChat({ chatId, type: 'error', error: err instanceof Error ? err.message : String(err) }))
    .finally(() => activeTurns.delete(chatId));
}

function registerIpc(): void {
  ipcMain.handle('setup:get', () => setup.state);
  ipcMain.handle('setup:start', () => { void setup.run(true); });
  ipcMain.handle('setup:check', () => { void setup.run(false); });
  // Opens the engine's download page. Allowed even when Online is off (user-clicked setup path).
  ipcMain.handle('engine:openDownloadPage', () => {
    assertOutboundAllowed(isOnline(), ENGINE_DOWNLOAD_URL);
    return shell.openExternal(ENGINE_DOWNLOAD_URL);
  });

  ipcMain.handle('online:get', () => isOnline());
  ipcMain.handle('online:set', (_e, on: unknown) => {
    const value = Boolean(on);
    db.setSetting(ONLINE_SETTING_KEY, onlineSettingValue(value));
    return isOnline();
  });

  ipcMain.handle('phone:get', () => phone.status());
  ipcMain.handle('phone:start', () => phone.start());
  ipcMain.handle('phone:stop', () => phone.stop());
  ipcMain.handle('phone:refreshCode', () => {
    if (!phone.status().running) return phone.start();
    return phone.refreshPairingCode();
  });

  ipcMain.handle('bots:list', () => db.listBots());
  ipcMain.handle('bots:create', (_e, input: NewBotForm) => db.createBot(toNewBot(input)));
  ipcMain.handle('bots:update', (_e, botId: unknown, input: unknown) =>
    db.updateBot(asId(botId), formToProfile((input && typeof input === 'object' ? input : {}) as Partial<NewBotForm>)));
  ipcMain.handle('routines:get', (_e, botId: unknown) => db.getRoutine(asId(botId)));
  ipcMain.handle('routines:set', (_e, botId: unknown, input: unknown) =>
    db.setRoutine(asId(botId), (input && typeof input === 'object' ? input : {}) as Record<string, unknown>));
  ipcMain.handle('bots:setFolder', (_e, botId: unknown, folder: unknown) => db.setBotFolder(asId(botId), asFolder(folder)));
  ipcMain.handle('bots:setTools', (_e, botId: unknown, enabled: unknown) => db.setBotTools(asId(botId), Boolean(enabled)));
  ipcMain.handle('bots:delete', (_e, botId: unknown) => db.deleteBot(asId(botId)));

  ipcMain.handle('dialog:pickFolder', async (e) => {
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
  ipcMain.handle('dialog:pickAttachFile', async (e, botIdRaw: unknown) => {
    const botId = asId(botIdRaw);
    const bot = db.getBot(botId);
    if (!bot) return { ok: false as const, error: 'Cipher bot not found.' };
    if (!bot.folderPath) {
      return { ok: false as const, error: 'Choose a folder for this Cipher bot before attaching a file.', needFolder: true };
    }
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = {
      title: 'Attach a text file from this Cipher bot\'s folder',
      defaultPath: bot.folderPath,
      properties: ['openFile' as const],
    };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (r.canceled || !r.filePaths[0]) return { ok: false as const, error: 'No file selected.' };
    try {
      const attached = await readFileForAttach(bot.folderPath, r.filePaths[0]);
      return { ok: true as const, relPath: attached.relPath, block: attached.block };
    } catch (err) {
      const msg = err instanceof ToolError ? err.message : (err instanceof Error ? err.message : 'Could not attach the file.');
      return { ok: false as const, error: msg };
    }
  });

  // One chat per bot: its most recent chat, created on first open. Older chats stay in the database, hidden.
  ipcMain.handle('chats:openForBot', (_e, botId: unknown) => db.getBotChat(asId(botId)));
  ipcMain.handle('messages:list', (_e, chatId: unknown) => db.listMessages(asId(chatId)));
  // Clear chat (after the UI confirm): deletes only this bot's 1:1 chat messages. Not while it's replying.
  ipcMain.handle('chats:clearForBot', (_e, botIdRaw: unknown) => {
    const botId = asId(botIdRaw);
    if (activeTurns.has(db.getBotChat(botId).id)) throw new Error('This chat is still replying.');
    return db.clearBotChat(botId);
  });
  ipcMain.handle('clipboard:writeText', (_e, text: unknown) => {
    if (typeof text !== 'string') throw new Error('Nothing to copy.');
    if (text.length > MAX_COPY_CHARS) throw new Error('This message is too long to copy.');
    clipboard.writeText(text);
  });
  // Export the open chat or room: native Save dialog, then a local plain-text file. No network.
  ipcMain.handle('chat:export', async (e, kind: unknown, idRaw: unknown) => {
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

  ipcMain.handle('chat:send', (_e, chatIdRaw: unknown, text: unknown) => {
    const chatId = asId(chatIdRaw);
    if (typeof text !== 'string' || !text.trim()) throw new Error('Message is empty.');
    if (activeTurns.has(chatId)) throw new Error('This chat is still replying.');
    const controller = new AbortController();
    activeTurns.set(chatId, controller);
    void beginChatTurn(chatId, text, broadcastChat, controller.signal, false)
      .catch((err: unknown) => broadcastChat({ chatId, type: 'error', error: err instanceof Error ? err.message : String(err) }))
      .finally(() => activeTurns.delete(chatId));
  });
  ipcMain.handle('chat:stop', (_e, chatId: unknown) => { activeTurns.get(asId(chatId))?.abort(); });

  // ---- rooms (group chats). No tools in rooms; see roomEngine.ts. ----
  ipcMain.handle('rooms:list', () => db.listRooms());
  ipcMain.handle('rooms:create', (_e, input: unknown) => {
    const form = (input && typeof input === 'object' ? input : {}) as Partial<NewRoomForm>;
    return db.createRoom({ name: form.name, botIds: form.botIds });
  });
  ipcMain.handle('roomMessages:list', (_e, roomId: unknown) => db.listRoomMessages(asId(roomId)));
  ipcMain.handle('room:send', (e, roomIdRaw: unknown, text: unknown) => {
    const roomId = asId(roomIdRaw);
    if (typeof text !== 'string' || !text.trim()) throw new Error('Message is empty.');
    if (!db.getRoom(roomId)) throw new Error('Room not found.');
    if (activeRooms.has(roomId)) throw new Error('This room is still replying.');
    const controller = new AbortController();
    activeRooms.set(roomId, controller);
    void runRoomTurn({ db, model: currentModel(), emit: broadcastRoom }, roomId, text, controller.signal)
      .catch((err: unknown) => broadcastRoom({ roomId, type: 'error', error: err instanceof Error ? err.message : String(err) }))
      .finally(() => activeRooms.delete(roomId));
  });
  ipcMain.handle('room:stop', (_e, roomId: unknown) => { activeRooms.get(asId(roomId))?.abort(); });
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
    if (app.isReady()) showWindow();
  });

  app.whenReady().then(() => {
    db = new CipherDb(path.join(app.getPath('userData'), 'cipher.db'));
    // Online defaults off: do not seed '1'. Absence means off.
    lockDownNetwork();
    setup = new SetupManager({ model: currentModel(), onChange: broadcastSetup });
    phone = new PhoneServer({
      db,
      staticDir: phoneStaticDir(),
      model: currentModel(),
      onStatus: () => broadcastPhone(),
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
          });
      },
      stopRoom: (roomId) => { activeRooms.get(roomId)?.abort(); },
    });
    registerIpc();
    // Daily routines: a main-process timer, only while Cipher runs (window open or in the tray). No OS scheduler.
    routines = new RoutineScheduler({
      listRoutines: () => db.listRoutines(),
      chatIdForBot: (botId) => db.getBotChat(botId).id,
      isBusy: (chatId) => activeTurns.has(chatId),
      markRun: (botId, dateKey) => db.markRoutineRun(botId, dateKey),
      run: (_botId, chatId, prompt) => runRoutineTurn(chatId, prompt),
    });
    routines.start();
    createWindow();
    createTray();
    void setup.run(true); // first launch: download the model through the local engine if it's missing
    app.on('activate', () => showWindow());
  });

  // Any real quit (tray Quit, Ctrl+Q, app.quit) lets the window close instead of hiding.
  app.on('before-quit', () => { quitting = true; });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', () => {
    routines?.stop();
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
