import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import type { ChatEvent, CipherApi, NewBotForm, NewRoomForm, PhoneLinkStatus, RoomEvent, SetupState } from '../shared/types';

const api: CipherApi = {
  listBots: () => ipcRenderer.invoke('bots:list'),
  createBot: (bot: NewBotForm) => ipcRenderer.invoke('bots:create', bot),
  updateBot: (botId, bot: NewBotForm) => ipcRenderer.invoke('bots:update', botId, bot),
  setBotFolder: (botId, folderPath) => ipcRenderer.invoke('bots:setFolder', botId, folderPath),
  setBotSecondFolder: (botId, folderPath) => ipcRenderer.invoke('bots:setSecondFolder', botId, folderPath),
  setBotTools: (botId, enabled) => ipcRenderer.invoke('bots:setTools', botId, enabled),
  deleteBot: (botId) => ipcRenderer.invoke('bots:delete', botId),
  deleteRoom: (roomId) => ipcRenderer.invoke('rooms:delete', roomId),
  showItemMenu: (kind) => ipcRenderer.invoke('menu:item', kind),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  pickAttachFile: (botId) => ipcRenderer.invoke('dialog:pickAttachFile', botId),
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
  attachDroppedFile: (botId, filePath) => ipcRenderer.invoke('attach:dropped', botId, filePath),
  getUiPrefs: () => ipcRenderer.invoke('prefs:get'),
  setUiPref: (name, value) => ipcRenderer.invoke('prefs:set', name, value),
  openBotChat: (botId) => ipcRenderer.invoke('chats:openForBot', botId),
  listMessages: (chatId) => ipcRenderer.invoke('messages:list', chatId),
  clearBotChat: (botId) => ipcRenderer.invoke('chats:clearForBot', botId),
  getRoutine: (botId) => ipcRenderer.invoke('routines:get', botId),
  setRoutine: (botId, routine) => ipcRenderer.invoke('routines:set', botId, routine),
  copyText: (text) => ipcRenderer.invoke('clipboard:writeText', text),
  exportChat: (kind, id) => ipcRenderer.invoke('chat:export', kind, id),
  sendMessage: (chatId, text) => ipcRenderer.invoke('chat:send', chatId, text),
  stop: (chatId) => ipcRenderer.invoke('chat:stop', chatId),
  onChatEvent: (cb) => {
    const listener = (_e: IpcRendererEvent, ev: ChatEvent) => cb(ev);
    ipcRenderer.on('chat:event', listener);
    return () => ipcRenderer.removeListener('chat:event', listener);
  },
  listRooms: () => ipcRenderer.invoke('rooms:list'),
  createRoom: (room: NewRoomForm) => ipcRenderer.invoke('rooms:create', room),
  listRoomMessages: (roomId) => ipcRenderer.invoke('roomMessages:list', roomId),
  sendRoomMessage: (roomId, text) => ipcRenderer.invoke('room:send', roomId, text),
  stopRoom: (roomId) => ipcRenderer.invoke('room:stop', roomId),
  onRoomEvent: (cb) => {
    const listener = (_e: IpcRendererEvent, ev: RoomEvent) => cb(ev);
    ipcRenderer.on('room:event', listener);
    return () => ipcRenderer.removeListener('room:event', listener);
  },
  getSetup: () => ipcRenderer.invoke('setup:get'),
  startSetup: () => ipcRenderer.invoke('setup:start'),
  checkSetup: () => ipcRenderer.invoke('setup:check'),
  openEngineDownload: () => ipcRenderer.invoke('engine:openDownloadPage'),
  onSetupState: (cb) => {
    const listener = (_e: IpcRendererEvent, s: SetupState) => cb(s);
    ipcRenderer.on('setup:state', listener);
    return () => ipcRenderer.removeListener('setup:state', listener);
  },
  reportOpenBot: (botId) => ipcRenderer.send('ui:openBot', botId),
  reportOpenRoom: (roomId) => ipcRenderer.send('ui:openRoom', roomId),
  markRead: (kind, id) => ipcRenderer.invoke('unread:clear', kind, id),
  onUnreadChanged: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('unread:changed', listener);
    return () => ipcRenderer.removeListener('unread:changed', listener);
  },
  getVersion: () => ipcRenderer.invoke('app:version'),
  getSendSound: () => ipcRenderer.invoke('sound:get'),
  setSendSound: (on) => ipcRenderer.invoke('sound:set', on),
  onOpenBot: (cb) => {
    const listener = (_e: IpcRendererEvent, botId: number) => cb(botId);
    ipcRenderer.on('routine:openBot', listener);
    return () => ipcRenderer.removeListener('routine:openBot', listener);
  },
  onSearchAsk: (cb) => {
    const listener = (_e: IpcRendererEvent, a: { id: string; chatId: number; query: string }) => cb(a);
    ipcRenderer.on('search:ask', listener);
    return () => ipcRenderer.removeListener('search:ask', listener);
  },
  onSearchClosed: (cb) => {
    const listener = (_e: IpcRendererEvent, a: { id: string }) => cb(a);
    ipcRenderer.on('search:closed', listener);
    return () => ipcRenderer.removeListener('search:closed', listener);
  },
  pendingSearches: () => ipcRenderer.invoke('search:pending'),
  answerSearch: (id, ok) => ipcRenderer.invoke('search:answer', id, ok),
  lastSearch: () => ipcRenderer.invoke('search:last'),
  openLink: (url, confirm) => ipcRenderer.invoke('link:open', url, confirm === true),
  openPage: (chatId, url) => ipcRenderer.invoke('page:open', chatId, url),
  onSearchSent: (cb) => {
    const listener = (_e: IpcRendererEvent, a: { at: string }) => cb(a);
    ipcRenderer.on('search:sent', listener);
    return () => ipcRenderer.removeListener('search:sent', listener);
  },
  searchHistory: () => ipcRenderer.invoke('search:history'),
  clearSearchHistory: () => ipcRenderer.invoke('search:clearHistory'),
  setBotMemory: (botId, note) => ipcRenderer.invoke('bots:setMemory', botId, note),
  deleteMessages: (chatId, ids) => ipcRenderer.invoke('messages:delete', chatId, ids),
  getOnline: () => ipcRenderer.invoke('online:get'),
  setOnline: (on) => ipcRenderer.invoke('online:set', on),
  getPhoneLink: () => ipcRenderer.invoke('phone:get'),
  startPhoneLink: () => ipcRenderer.invoke('phone:start'),
  stopPhoneLink: () => ipcRenderer.invoke('phone:stop'),
  refreshPhoneLinkCode: () => ipcRenderer.invoke('phone:refreshCode'),
  onPhoneLink: (cb) => {
    const listener = (_e: IpcRendererEvent, s: PhoneLinkStatus) => cb(s);
    ipcRenderer.on('phone:status', listener);
    return () => ipcRenderer.removeListener('phone:status', listener);
  },
  getLockState: () => ipcRenderer.invoke('lock:state'),
  unlock: (passphrase) => ipcRenderer.invoke('lock:unlock', passphrase),
  enableLock: (passphrase, confirm) => ipcRenderer.invoke('lock:enable', passphrase, confirm),
  changeLock: (current, passphrase, confirm) => ipcRenderer.invoke('lock:change', current, passphrase, confirm),
  disableLock: (current) => ipcRenderer.invoke('lock:disable', current),
  backup: () => ipcRenderer.invoke('data:backup'),
  pickRestore: () => ipcRenderer.invoke('data:restorePick'),
  confirmRestore: () => ipcRenderer.invoke('data:restoreConfirm'),
};

contextBridge.exposeInMainWorld('cipher', api);
