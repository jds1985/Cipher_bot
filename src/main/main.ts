import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';
import path from 'node:path';
import type { ChatEvent, NewBotForm, NewRoomForm, RoomEvent, SetupState } from '../shared/types';
import { CipherDb } from './db';
import { runChatTurn } from './chatEngine';
import { runRoomTurn } from './roomEngine';
import { toNewBot } from './createBot';
import { configuredModel, ENGINE_DOWNLOAD_URL } from './ollama';
import { SetupManager } from './setup';
import { ONLINE_SETTING_KEY, assertOutboundAllowed, onlineSettingValue, parseOnlineSetting } from './networkGuard';
import { PhoneServer, PHONE_LINK_PORT } from './phoneServer';
import { readFileForAttach } from './attachFile';
import { ToolError } from './readFileTool';

let db: CipherDb;
let setup: SetupManager;
let phone: PhoneServer;
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
    icon: path.join(__dirname, '..', 'renderer', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.removeMenu();
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

/** Start a 1:1 turn shared by desktop IPC and phone link. */
function beginChatTurn(chatId: number, text: string, emit: (e: ChatEvent) => void, signal: AbortSignal, toolsOff: boolean): Promise<void> {
  return runChatTurn({ db, model: currentModel(), emit, forceToolsOff: toolsOff }, chatId, text, signal);
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
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
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
    createWindow();
    void setup.run(true); // first launch: download the model through the local engine if it's missing
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', () => {
    for (const c of activeTurns.values()) c.abort();
    for (const c of activeRooms.values()) c.abort();
    phone?.stop();
    db?.close();
  });
}

// Re-export port for docs/tests.
export { PHONE_LINK_PORT };
