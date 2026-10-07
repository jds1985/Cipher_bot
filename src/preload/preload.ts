import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { ChatEvent, CipherApi, NewBotForm, NewRoomForm, RoomEvent, SetupState } from '../shared/types';

const api: CipherApi = {
  listBots: () => ipcRenderer.invoke('bots:list'),
  createBot: (bot: NewBotForm) => ipcRenderer.invoke('bots:create', bot),
  setBotFolder: (botId, folderPath) => ipcRenderer.invoke('bots:setFolder', botId, folderPath),
  setBotTools: (botId, enabled) => ipcRenderer.invoke('bots:setTools', botId, enabled),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  openBotChat: (botId) => ipcRenderer.invoke('chats:openForBot', botId),
  listMessages: (chatId) => ipcRenderer.invoke('messages:list', chatId),
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
};

contextBridge.exposeInMainWorld('cipher', api);
