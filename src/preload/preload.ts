import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { ChatEvent, CipherApi, NewBotForm, NewRoomForm, PhoneLinkStatus, RoomEvent, SetupState } from '../shared/types';

const api: CipherApi = {
  listBots: () => ipcRenderer.invoke('bots:list'),
  createBot: (bot: NewBotForm) => ipcRenderer.invoke('bots:create', bot),
  updateBot: (botId, bot: NewBotForm) => ipcRenderer.invoke('bots:update', botId, bot),
  setBotFolder: (botId, folderPath) => ipcRenderer.invoke('bots:setFolder', botId, folderPath),
  setBotTools: (botId, enabled) => ipcRenderer.invoke('bots:setTools', botId, enabled),
  deleteBot: (botId) => ipcRenderer.invoke('bots:delete', botId),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  pickAttachFile: (botId) => ipcRenderer.invoke('dialog:pickAttachFile', botId),
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
};

contextBridge.exposeInMainWorld('cipher', api);
