import { app, BrowserWindow, dialog, ipcMain, session } from 'electron';
import path from 'node:path';
import type { ChatEvent, NewBot } from '../shared/types';
import { CipherDb } from './db';
import { runChatTurn } from './chatEngine';
import { configuredModel, getStatus } from './ollama';

let db: CipherDb;
const activeTurns = new Map<number, AbortController>();
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

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 760,
    minHeight: 480,
    title: 'Cipher',
    backgroundColor: '#15171c',
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

function registerIpc(): void {
  ipcMain.handle('ollama:status', () => getStatus(configuredModel()));

  ipcMain.handle('bots:list', () => db.listBots());
  ipcMain.handle('bots:create', (_e, input: NewBot) =>
    db.createBot({
      name: String(input?.name ?? ''),
      systemPrompt: String(input?.systemPrompt ?? ''),
      toolsEnabled: Boolean(input?.toolsEnabled),
      folderPath: asFolder(input?.folderPath),
    }),
  );
  ipcMain.handle('bots:setFolder', (_e, botId: unknown, folder: unknown) => db.setBotFolder(asId(botId), asFolder(folder)));
  ipcMain.handle('bots:setTools', (_e, botId: unknown, enabled: unknown) => db.setBotTools(asId(botId), Boolean(enabled)));

  ipcMain.handle('dialog:pickFolder', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = { title: 'Choose a folder this bot may read', properties: ['openDirectory' as const] };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (r.canceled || !r.filePaths[0]) return null;
    pickedFolders.add(r.filePaths[0]);
    return r.filePaths[0];
  });

  ipcMain.handle('chats:list', (_e, botId: unknown) => db.listChats(asId(botId)));
  ipcMain.handle('chats:create', (_e, botId: unknown) => db.createChat(asId(botId)));
  ipcMain.handle('messages:list', (_e, chatId: unknown) => db.listMessages(asId(chatId)));

  ipcMain.handle('chat:send', (e, chatIdRaw: unknown, text: unknown) => {
    const chatId = asId(chatIdRaw);
    if (typeof text !== 'string' || !text.trim()) throw new Error('Message is empty.');
    if (activeTurns.has(chatId)) throw new Error('This chat is still replying.');
    const controller = new AbortController();
    activeTurns.set(chatId, controller);
    const sender = e.sender;
    const emit = (ev: ChatEvent) => { if (!sender.isDestroyed()) sender.send('chat:event', ev); };
    runChatTurn({ db, model: configuredModel(), emit }, chatId, text, controller.signal)
      .catch((err: unknown) => emit({ chatId, type: 'error', error: err instanceof Error ? err.message : String(err) }))
      .finally(() => activeTurns.delete(chatId));
  });
  ipcMain.handle('chat:stop', (_e, chatId: unknown) => { activeTurns.get(asId(chatId))?.abort(); });
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
    lockDownNetwork();
    registerIpc();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', () => {
    for (const c of activeTurns.values()) c.abort();
    db?.close();
  });
}
