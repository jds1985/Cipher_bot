import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { ChatEvent, CipherApi, NewBotForm, SetupState } from '../shared/types';

const api: CipherApi = {
  listBots: () => ipcRenderer.invoke('bots:list'),
  createBot: (bot: NewBotForm) => ipcRenderer.invoke('bots:create', bot),
  setBotFolder: (botId, folderPath) => ipcRenderer.invoke('bots:setFolder', botId, folderPath),
  setBotTools: (botId, enabled) => ipcRenderer.invoke('bots:setTools', botId, enabled),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  listChats: (botId) => ipcRenderer.invoke('chats:list', botId),
  createChat: (botId) => ipcRenderer.invoke('chats:create', botId),
  listMessages: (chatId) => ipcRenderer.invoke('messages:list', chatId),
  sendMessage: (chatId, text) => ipcRenderer.invoke('chat:send', chatId, text),
  stop: (chatId) => ipcRenderer.invoke('chat:stop', chatId),
  onChatEvent: (cb) => {
    const listener = (_e: IpcRendererEvent, ev: ChatEvent) => cb(ev);
    ipcRenderer.on('chat:event', listener);
    return () => ipcRenderer.removeListener('chat:event', listener);
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
};

contextBridge.exposeInMainWorld('cipher', api);
