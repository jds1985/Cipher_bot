import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import type { ChatEvent, CipherApi, NewBotForm, NewRoomForm, PhoneLinkStatus, RoomEvent, SetupState, UpdateState } from '../shared/types';

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
  setToolSwitches: (botId, update) => ipcRenderer.invoke('bots:setToolSwitches', botId, update),
  undoDelete: (undoId) => ipcRenderer.invoke('undo:delete', undoId),
  pasteImage: (chatId, bytes) => ipcRenderer.invoke('image:pasted', chatId, bytes),
  discardPastedImage: (chatId) => ipcRenderer.invoke('image:discardPasted', chatId),
  reminders: (botId) => ipcRenderer.invoke('reminders:list', botId),
  addReminder: (botId, at, prompt) => ipcRenderer.invoke('reminders:add', botId, at, prompt),
  deleteReminder: (botId, id) => ipcRenderer.invoke('reminders:delete', botId, id),
  onReminders: (cb) => {
    const fn = (_e: IpcRendererEvent, botId: number) => cb(botId);
    ipcRenderer.on('reminders:changed', fn);
    return () => ipcRenderer.removeListener('reminders:changed', fn);
  },
  diskUsage: () => ipcRenderer.invoke('disk:usage'),
  getRoutine: (botId) => ipcRenderer.invoke('routines:get', botId),
  setRoutine: (botId, routine) => ipcRenderer.invoke('routines:set', botId, routine),
  copyText: (text) => ipcRenderer.invoke('clipboard:writeText', text),
  exportChat: (kind, id) => ipcRenderer.invoke('chat:export', kind, id),
  sendMessage: (chatId, text, extras) => ipcRenderer.invoke('chat:send', chatId, text, extras ?? {}),
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
  setArchived: (kind, id, on) => ipcRenderer.invoke('archive:set', kind, id, on === true),
  setReplyLength: (botId, value) => ipcRenderer.invoke('bots:setReplyLength', botId, value),
  blockedSites: () => ipcRenderer.invoke('sites:list'),
  addBlockedSite: (site) => ipcRenderer.invoke('sites:add', site),
  removeBlockedSite: (site) => ipcRenderer.invoke('sites:remove', site),
  getAlwaysOnTop: () => ipcRenderer.invoke('window:getAlwaysOnTop'),
  setAlwaysOnTop: (on) => ipcRenderer.invoke('window:setAlwaysOnTop', on === true),
  onAlwaysOnTop: (cb) => {
    const listener = (_e: IpcRendererEvent, on: boolean) => cb(on);
    ipcRenderer.on('window:alwaysOnTop', listener);
    return () => ipcRenderer.removeListener('window:alwaysOnTop', listener);
  },
  tipsPending: () => ipcRenderer.invoke('tips:get'),
  tipsDone: () => ipcRenderer.invoke('tips:done'),
  copyChatMarkdown: (botId) => ipcRenderer.invoke('chat:markdown', botId),
  copyMarkdown: (kind, id) => ipcRenderer.invoke('chat:markdown', kind, id),
  getAccent: () => ipcRenderer.invoke('accent:get'),
  setAccent: (accent) => ipcRenderer.invoke('accent:set', accent),
  rememberMessage: (chatId, messageId) => ipcRenderer.invoke('memory:remember', chatId, messageId),
  checklist: (botId) => ipcRenderer.invoke('checklist:list', botId),
  checklistAdd: (botId, text) => ipcRenderer.invoke('checklist:add', botId, text),
  checklistSetDone: (botId, itemId, done) => ipcRenderer.invoke('checklist:done', botId, itemId, done),
  checklistDelete: (botId, itemId) => ipcRenderer.invoke('checklist:delete', botId, itemId),
  onChecklist: (cb) => {
    const fn = (_e: IpcRendererEvent, botId: number) => cb(botId);
    ipcRenderer.on('checklist:changed', fn);
    return () => ipcRenderer.removeListener('checklist:changed', fn);
  },
  pinMessage: (chatId, id, on) => ipcRenderer.invoke('messages:pin', chatId, id, on === true),
  listPinned: (chatId) => ipcRenderer.invoke('messages:pinned', chatId),
  setMuted: (kind, id, on) => ipcRenderer.invoke('mute:set', kind, id, on === true),
  attachDroppedImage: (botId, filePath) => ipcRenderer.invoke('image:dropped', botId, filePath),
  getImage: (chatId, messageId) => ipcRenderer.invoke('image:get', chatId, messageId),
  getUpdate: () => ipcRenderer.invoke('update:get'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  showUpdateFile: () => ipcRenderer.invoke('update:showFile'),
  onUpdate: (cb) => {
    const listener = (_e: IpcRendererEvent, s: UpdateState) => cb(s);
    ipcRenderer.on('update:state', listener);
    return () => ipcRenderer.removeListener('update:state', listener);
  },
  exportDebugLog: (includeChats) => ipcRenderer.invoke('debug:export', includeChats === true),
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
  // v1.24
  getSharedFolder: () => ipcRenderer.invoke('shared:get'),
  pickSharedFolder: () => ipcRenderer.invoke('shared:pick'),
  clearSharedFolder: () => ipcRenderer.invoke('shared:clear'),
  getLockTimeout: () => ipcRenderer.invoke('locktimeout:get'),
  setLockTimeout: (v) => ipcRenderer.invoke('locktimeout:set', v),
  getShowTps: () => ipcRenderer.invoke('tps:get'),
  setShowTps: (on) => ipcRenderer.invoke('tps:set', on),
  getFont: () => ipcRenderer.invoke('font:get'),
  setFont: (v) => ipcRenderer.invoke('font:set', v),
  reactMessage: (chatId, id, r) => ipcRenderer.invoke('messages:react', chatId, id, r),
  editMessage: (chatId, id, text) => ipcRenderer.invoke('messages:edit', chatId, id, text),
  listMessageEdits: (chatId, id) => ipcRenderer.invoke('messages:edits', chatId, id),
  botActivity: (botId) => ipcRenderer.invoke('bots:activity', botId),
  setBotTags: (botId, tags) => ipcRenderer.invoke('bots:setTags', botId, tags),
  setBotGroup: (botId, g) => ipcRenderer.invoke('bots:setGroup', botId, g),
  getDockGroupsCollapsed: () => ipcRenderer.invoke('dock:groupsCollapsed'),
  setDockGroupsCollapsed: (list) => ipcRenderer.invoke('dock:setGroupsCollapsed', list),
  importReminder: (botId, line) => ipcRenderer.invoke('reminders:import', botId, line),
  summarizeFolder: (chatId) => ipcRenderer.invoke('folder:summarize', chatId),
  getBackupSchedule: () => ipcRenderer.invoke('backupsched:get'),
  setBackupSchedule: (v) => ipcRenderer.invoke('backupsched:set', v),
  pickBackupFolder: () => ipcRenderer.invoke('backupsched:pick'),
  exportSettings: (m) => ipcRenderer.invoke('settings:export', m),
  importSettings: (m) => ipcRenderer.invoke('settings:import', m),
  // v1.25
  listDrafts: (chatId) => ipcRenderer.invoke('drafts:list', chatId),
  saveDraft: (chatId, id) => ipcRenderer.invoke('drafts:save', chatId, id),
  discardDraft: (chatId, id) => ipcRenderer.invoke('drafts:discard', chatId, id),
  onDrafts: (cb) => {
    const fn = (_e: IpcRendererEvent, chatId: number) => cb(chatId);
    ipcRenderer.on('drafts:changed', fn);
    return () => ipcRenderer.removeListener('drafts:changed', fn);
  },
  voiceState: () => ipcRenderer.invoke('voice:state'),
  pickVoiceEngine: () => ipcRenderer.invoke('voice:pickEngine'),
  pickVoiceModel: () => ipcRenderer.invoke('voice:pickModel'),
  clearVoice: () => ipcRenderer.invoke('voice:clear'),
  transcribe: (pcm) => ipcRenderer.invoke('voice:transcribe', pcm),
  weeklyReport: () => ipcRenderer.invoke('report:weekly'),
  saveWeeklyReport: () => ipcRenderer.invoke('report:save'),
};

contextBridge.exposeInMainWorld('cipher', api);
