import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { ChatEvent, CipherApi, NewBot } from '../shared/types';

const api: CipherApi = {
  ollamaStatus: () => ipcRenderer.invoke('ollama:status'),
  listBots: () => ipcRenderer.invoke('bots:list'),
  createBot: (bot: NewBot) => ipcRenderer.invoke('bots:create', bot),
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
};

contextBridge.exposeInMainWorld('cipher', api);
