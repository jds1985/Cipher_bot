import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { ChatEvent, CipherApi, NewBot, PullEvent } from '../shared/types';

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
  listModels: () => ipcRenderer.invoke('models:list'),
  selectModel: (name) => ipcRenderer.invoke('models:select', name),
  pullModel: (name) => ipcRenderer.invoke('models:pull', name),
  cancelPull: (name) => ipcRenderer.invoke('models:cancelPull', name),
  onPullEvent: (cb) => {
    const listener = (_e: IpcRendererEvent, ev: PullEvent) => cb(ev);
    ipcRenderer.on('pull:event', listener);
    return () => ipcRenderer.removeListener('pull:event', listener);
  },
};

contextBridge.exposeInMainWorld('cipher', api);
