import type { DraftInfo, VoiceState, UiPrefsState, BackupScheduleState, Bot, Chat, ChecklistItem, MessageEdit, DiskUsage, Reminder, ToolSwitches, ChatEvent, CipherApi, LockState, Message, PhoneLinkStatus, Room, RoomEvent, RoomMessage, Routine, SetupState, UnlockResult, UpdateState } from '../shared/types';
import { WHATS_NEW } from './whatsNew.js';
import { renderMarkdown } from './markdown.js';
import { decideView, formatReminderAt, formatSize, formatMessageTime, plusMenuItems, roomTitle, setupCopy, SHORTCUTS, showsSplash, splashRemainingMs, SPLASH_MAX_MS, STARTER_JOBS, TIPS, findRanges, type PlusItem, type PlusItemId,
  REACTION_CHOICES, allTags, localVoices, searchMemory, reactionCount, floatToPcm16, autoTitle, dockSections, formatActivity, tokensPerSecond } from './view.js';
import { POLICY_CONTACT, POLICY_SECTIONS, POLICY_TITLE } from './policy.js';
import { BOT_COLORS, BOT_SHAPES, COLOR_LABELS, DEFAULT_COLOR, SHAPE_LABELS, colorClass, colorOf, leastUsedShape, shapeOf, shapeSvg } from './botIcon.js';

declare global {
  interface Window { cipher: CipherApi }
}

const api = window.cipher;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const el = {
  mic: $<HTMLButtonElement>('mic'), compactSwitch: $<HTMLInputElement>('compact-switch'),
  voiceTested: $('voice-tested'), voiceEngine: $('voice-engine'), voiceModel: $('voice-model'),
  voicePickEngine: $<HTMLButtonElement>('voice-pick-engine'), voicePickModel: $<HTMLButtonElement>('voice-pick-model'),
  voiceClear: $<HTMLButtonElement>('voice-clear'), voiceError: $('voice-error'),
  reportOpen: $<HTMLButtonElement>('report-open'), reportModal: $('report-modal'), reportText: $('report-text'),
  reportMsg: $('report-msg'), reportSave: $<HTMLButtonElement>('report-save'), reportClose: $<HTMLButtonElement>('report-close'),
  memorySearchWrap: $('memory-search-wrap'), memorySearch: $<HTMLInputElement>('memory-search'), memoryResults: $('memory-results'),
  splash: $('splash'),
  search: $<HTMLInputElement>('search'),
  botList: $('bot-list'), roomList: $('room-list'),
  newBot: $<HTMLButtonElement>('new-bot'), newRoom: $<HTMLButtonElement>('new-room'), newRoomMark: $('new-room-mark'),
  formView: $('bot-form-view'), roomFormView: $('room-form-view'), chatView: $('chat-view'), setupView: $('setup-view'),
  form: $<HTMLFormElement>('bot-form'), botName: $<HTMLInputElement>('bot-name'), botJob: $<HTMLTextAreaElement>('bot-job'),
  shapePicker: $('shape-picker'), colorPicker: $('color-picker'),
  botFormError: $('bot-form-error'), botCancel: $<HTMLButtonElement>('bot-cancel'),
  botFormArt: $('bot-form-art'), botFormTitle: $('bot-form-title'), botSubmit: $<HTMLButtonElement>('bot-submit'),
  roomForm: $<HTMLFormElement>('room-form'), roomName: $<HTMLInputElement>('room-name'), roomMembers: $('room-members'),
  roomFormError: $('room-form-error'), roomCancel: $<HTMLButtonElement>('room-cancel'), roomCreate: $<HTMLButtonElement>('room-create'),
  setupText: $('setup-text'), setupProgress: $<HTMLProgressElement>('setup-progress'), setupDetail: $('setup-detail'),
  setupGetEngine: $<HTMLButtonElement>('setup-get-engine'), setupRetry: $<HTMLButtonElement>('setup-retry'),
  chatIcon: $('chat-icon'), chatBotName: $('chat-bot-name'),
  messages: $('messages'), composer: $<HTMLFormElement>('composer'), input: $<HTMLTextAreaElement>('input'),
  plus: $<HTMLButtonElement>('plus'), plusMenu: $('plus-menu'),
  attachChip: $('attach-chip'), attachChipName: $('attach-chip-name'),
  attachClear: $<HTMLButtonElement>('attach-clear'), attachError: $('attach-error'),
  send: $<HTMLButtonElement>('send'), stop: $<HTMLButtonElement>('stop'),
  settingsView: $('settings-view'), openSettings: $<HTMLButtonElement>('open-settings'),
  settingsClose: $<HTMLButtonElement>('settings-close'),
  openPolicy: $<HTMLButtonElement>('open-policy'), policyView: $('policy-view'), policyTitle: $('policy-title'),
  policyBody: $('policy-body'), policyContact: $('policy-contact'), policyClose: $<HTMLButtonElement>('policy-close'),
  routineModal: $('routine-modal'), routineForm: $<HTMLFormElement>('routine-form'),
  routineTitle: $('routine-title'), routinePrompt: $<HTMLTextAreaElement>('routine-prompt'), routineTime: $<HTMLInputElement>('routine-time'),
  routineEnabled: $<HTMLInputElement>('routine-enabled'), routineError: $('routine-error'), routineCancel: $<HTMLButtonElement>('routine-cancel'),
  onlineSwitch: $<HTMLInputElement>('online-switch'),
  phoneStart: $<HTMLButtonElement>('phone-start'), phoneStop: $<HTMLButtonElement>('phone-stop'),
  phoneRefresh: $<HTMLButtonElement>('phone-refresh'), phoneStatus: $('phone-status'),
  phoneCode: $('phone-code'), phoneExpiry: $('phone-expiry'), phoneUrls: $('phone-urls'),
  phoneQrWrap: $('phone-qr-wrap'), phoneQr: $<HTMLImageElement>('phone-qr'), phonePrimaryUrl: $('phone-primary-url'),
  confirmModal: $('confirm-modal'), confirmTitle: $('confirm-title'), confirmBody: $('confirm-body'),
  confirmCancel: $<HTMLButtonElement>('confirm-cancel'), confirmOk: $<HTMLButtonElement>('confirm-ok'),
  lockScreen: $('lock-screen'), lockForm: $<HTMLFormElement>('lock-form'), lockPass: $<HTMLInputElement>('lock-pass'),
  lockPassError: $('lock-pass-error'), lockUnlock: $<HTMLButtonElement>('lock-unlock'),
  lockStatus: $('lock-status'), lockMsg: $('lock-msg'), lockError: $('lock-error'),
  lockSetForm: $<HTMLFormElement>('lock-set-form'), lockSetNew: $<HTMLInputElement>('lock-set-new'), lockSetConfirm: $<HTMLInputElement>('lock-set-confirm'),
  lockChangeForm: $<HTMLFormElement>('lock-change-form'), lockChangeCurrent: $<HTMLInputElement>('lock-change-current'),
  lockChangeNew: $<HTMLInputElement>('lock-change-new'), lockChangeConfirm: $<HTMLInputElement>('lock-change-confirm'),
  lockOffForm: $<HTMLFormElement>('lock-off-form'), lockOffCurrent: $<HTMLInputElement>('lock-off-current'),
  backupBtn: $<HTMLButtonElement>('backup-btn'), backupMsg: $('backup-msg'), backupError: $('backup-error'),
  restoreBtn: $<HTMLButtonElement>('restore-btn'), restoreError: $('restore-error'),
  botMemoryWrap: $('bot-memory-wrap'), botMemory: $<HTMLTextAreaElement>('bot-memory'),
  searchHistory: $('search-history'), searchHistoryEmpty: $('search-history-empty'), searchHistoryClear: $<HTMLButtonElement>('search-history-clear'),
  selectBar: $('select-bar'), selectCount: $('select-count'), selectCancel: $<HTMLButtonElement>('select-cancel'), selectDelete: $<HTMLButtonElement>('select-delete'),
  soundSwitch: $<HTMLInputElement>('sound-switch'), settingsVersion: $('settings-version'),
  timesSwitch: $<HTMLInputElement>('times-switch'), dockToggle: $<HTMLButtonElement>('dock-toggle'),
  whatsNew: $('whats-new'), dropHint: $('drop-hint'),
  onlineState: $('online-state'), onlineOnIcon: $<HTMLImageElement>('online-on-icon'), lastSearch: $('last-search'),
  openAbout: $<HTMLButtonElement>('open-about'), aboutView: $('about-view'), aboutVersion: $('about-version'),
  aboutPolicy: $<HTMLButtonElement>('about-policy'), aboutClose: $<HTMLButtonElement>('about-close'),
  // v1.20
  starterJobs: $('starter-jobs'), pinnedStrip: $('pinned-strip'),
  quoteChip: $('quote-chip'), quoteChipText: $('quote-chip-text'), quoteClear: $<HTMLButtonElement>('quote-clear'),
  imageChip: $('image-chip'), imageChipPreview: $<HTMLImageElement>('image-chip-preview'), imageChipName: $('image-chip-name'), imageClear: $<HTMLButtonElement>('image-clear'),
  updateLast: $('update-last'), updateStatus: $('update-status'), updateDownload: $<HTMLButtonElement>('update-download'), updateShow: $<HTMLButtonElement>('update-show'),
  alwaysOnTop: $<HTMLButtonElement>('always-on-top'), replyLengthWrap: $('reply-length-wrap'), replyLength: $<HTMLSelectElement>('reply-length'),
  siteForm: $<HTMLFormElement>('site-form'), siteInput: $<HTMLInputElement>('site-input'), siteError: $('site-error'), siteList: $('site-list'), siteEmpty: $('site-empty'),
  archivedList: $('archived-list'), archivedEmpty: $('archived-empty'),
  imageViewer: $('image-viewer'), imageViewerImg: $<HTMLImageElement>('image-viewer-img'), imageViewerName: $('image-viewer-name'), imageViewerClose: $<HTMLButtonElement>('image-viewer-close'),
  findBar: $('find-bar'), findInput: $<HTMLInputElement>('find-input'), findCount: $('find-count'), findPrev: $<HTMLButtonElement>('find-prev'),
  findNext: $<HTMLButtonElement>('find-next'), findClose: $<HTMLButtonElement>('find-close'),
  accentList: $('accent-list'), motionSwitch: $<HTMLInputElement>('motion-switch'),
  checklistModal: $('checklist-modal'), checklistName: $('checklist-name'), checklistList: $('checklist-list'), checklistEmpty: $('checklist-empty'),
  checklistForm: $<HTMLFormElement>('checklist-form'), checklistInput: $<HTMLInputElement>('checklist-input'), checklistError: $('checklist-error'),
  checklistClose: $<HTMLButtonElement>('checklist-close'),
  toolsModal: $('tools-modal'), toolsName: $('tools-name'), toolsList: $('tools-list'), toolsError: $('tools-error'), toolsClose: $<HTMLButtonElement>('tools-close'),
  reminderModal: $('reminder-modal'), reminderName: $('reminder-name'), reminderList: $('reminder-list'), reminderEmpty: $('reminder-empty'),
  reminderForm: $<HTMLFormElement>('reminder-form'), reminderDate: $<HTMLInputElement>('reminder-date'), reminderTime: $<HTMLInputElement>('reminder-time'),
  reminderPrompt: $<HTMLTextAreaElement>('reminder-prompt'), reminderError: $('reminder-error'), reminderClose: $<HTMLButtonElement>('reminder-close'),
  undoToast: $('undo-toast'), undoText: $('undo-text'), undoBtn: $<HTMLButtonElement>('undo-btn'),
  focusToggle: $<HTMLButtonElement>('focus-toggle'), diskList: $('disk-list'), diskRefresh: $<HTMLButtonElement>('disk-refresh'),
  tips: $('tips'), tipIcon: $<HTMLImageElement>('tip-icon'), tipTitle: $('tip-title'), tipBody: $('tip-body'), tipStep: $('tip-step'), tipSkip: $<HTMLButtonElement>('tip-skip'), tipNext: $<HTMLButtonElement>('tip-next'),
  shortcutList: $('shortcut-list'), debugChats: $<HTMLInputElement>('debug-chats'), debugExport: $<HTMLButtonElement>('debug-export'), debugMsg: $('debug-msg'),
  // v1.24
  tagFilter: $<HTMLSelectElement>('tag-filter'), botTags: $<HTMLInputElement>('bot-tags'), botGroup: $<HTMLInputElement>('bot-group'),
  botGroupList: $('bot-group-list'), chatActivity: $('chat-activity'),
  lockTimeout: $<HTMLSelectElement>('lock-timeout'), tpsSwitch: $<HTMLInputElement>('tps-switch'), fontSelect: $<HTMLSelectElement>('font-select'),
  backupSchedule: $<HTMLSelectElement>('backup-schedule'), backupFolderBtn: $<HTMLButtonElement>('backup-folder-btn'),
  backupSchedMsg: $('backup-sched-msg'), backupSchedError: $('backup-sched-error'),
  sharedFolderPath: $('shared-folder-path'), sharedFolderPick: $<HTMLButtonElement>('shared-folder-pick'), sharedFolderClear: $<HTMLButtonElement>('shared-folder-clear'),
  settingsMemory: $<HTMLInputElement>('settings-memory'), settingsExport: $<HTMLButtonElement>('settings-export'), settingsImport: $<HTMLButtonElement>('settings-import'),
  settingsFileMsg: $('settings-file-msg'), settingsFileError: $('settings-file-error'),
  editsModal: $('edits-modal'), editsList: $('edits-list'), editsClose: $<HTMLButtonElement>('edits-close'),
  reminderImportForm: $<HTMLFormElement>('reminder-import-form'), reminderLine: $<HTMLInputElement>('reminder-line'),
};

const CHAT_PLACEHOLDER = el.input.placeholder;
const ROOM_PLACEHOLDER = 'Message the room (each Cipher bot replies once; type @Name to ask just one)';

const state = {
  /** v1.24: dock tag filter ('' = all), collapsed dock folders, tokens/s display and per-reply measurements. */
  tagFilter: '',
  groupsCollapsed: [] as string[],
  showTps: false,
  tps: new Map<number, string>(),
  tpsRun: new Map<number, { start: number; tokens: number }>(),
  activity: '',
  /** v1.24: the name was typed by the user (auto-title stops filling it in). */
  nameTouched: false,
  editingMsg: null as number | null,
  bots: [] as Bot[],
  rooms: [] as Room[],
  /** The open bot's one chat (bot mode). */
  chat: null as Chat | null,
  messages: [] as Message[],
  roomMessages: [] as RoomMessage[],
  botId: null as number | null,
  roomId: null as number | null,
  live: '',
  error: null as string | null,
  busy: new Set<number>(),
  /** Rooms with a round in progress, and who is speaking + what they've streamed so far. */
  roomLive: new Map<number, { botId: number | null; text: string }>(),
  formOpen: false,
  /** The bot being edited in the edit modal (the create form, reused), or null. */
  editBotId: null as number | null,
  roomFormOpen: false,
  settingsOpen: false,
  /** Policy screen (opened from Settings). */
  policyOpen: false,
  /** v1.16: About screen (opened from Settings). */
  aboutOpen: false,
  /** v1.16: the app version from main (app.getVersion()); '' until loaded. */
  version: '',
  /** v1.16: optional send sound (off by default). */
  sendSound: false,
  /** v1.17: display preferences (stored in main): message times (on by default), dock collapsed (off by default). */
  prefs: { showTimes: true, dockCollapsed: false, reduceMotion: false, compact: false } as UiPrefsState,
  /** v1.18: confirm cards main is waiting on (id → chat and exact query). */
  searchAsks: new Map<string, { chatId: number; query: string }>(),
  /** v1.19: multi-select: on/off and the chosen message ids. */
  selecting: false,
  selected: new Set<number>(),
  /** v1.18: ISO time of the last search sent, or null. */
  lastSearch: null as string | null,
  /** The open bot's daily routine, or null if it has none. */
  routine: null as Routine | null,
  /** Bot ids currently streaming a reply (working-dot). */
  speakingBots: new Set<number>(),
  online: false,
  phone: { running: false, port: 17865, pairingCode: null, pairingExpiresAt: null, urls: [], sessionCount: 0, primaryUrl: null, qrDataUrl: null } as PhoneLinkStatus,
  setup: { phase: 'checking', percent: null, completed: 0, total: 0, message: null } as SetupState,
  /** Client-side filter for bot/room names and open-chat messages. */
  searchQuery: '',
  /** Desktop-only pending attach block for the next 1:1 send (rooms skipped). */
  pendingAttach: null as { relPath: string; block: string } | null,
  /** v1.20: the message being quoted in the next send, and a dropped image (folder-relative path + data: preview). */
  quote: null as { id: number; text: string } | null,
  pendingImage: null as { relPath: string; dataUrl: string } | null,
  /** v1.20: message id → data: URL from main (local bytes only). */
  images: new Map<number, string | null>(),
  update: null as UpdateState | null,
  /** App lock (v1.13). Starts locked until main says otherwise, so nothing loads before the check. */
  lock: { enabled: true, locked: true } as LockState,
};

/** v1.21: bots and rooms not archived (the dock, pickers and defaults use these). */
const activeBots = () => state.bots.filter((b) => !b.archived);
const activeRooms = () => state.rooms.filter((r) => !r.archived);
const currentBot = () => state.bots.find((b) => b.id === state.botId) ?? null;
const currentRoom = () => state.rooms.find((r) => r.id === state.roomId) ?? null;
const botById = (id: number | null) => state.bots.find((b) => b.id === id) ?? null;
const roomMembers = (r: Room): Bot[] => r.memberIds.map((id) => botById(id)).filter((b): b is Bot => b !== null);
const roomName = (r: Room): string => roomTitle(r.name, roomMembers(r).map((b) => b.name));

function node(tag: string, cls?: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

// ---------- bot icons ----------
// Liz's v1.5 icons are drawn in currentColor with a dark body. They are inlined from the bundled, trusted SVG
// strings (botIconSvgs.ts, generated from her files; never from user input), parsed once per shape with
// DOMParser, so the color class applies. No inline styles: size via attributes, color via a .c-<key> class.
const parsedShapes = new Map<string, SVGSVGElement>();
function shapeTemplate(shape: unknown): SVGSVGElement {
  const key = shapeOf(shape);
  let svg = parsedShapes.get(key);
  if (!svg) {
    const doc = new DOMParser().parseFromString(shapeSvg(key), 'image/svg+xml');
    svg = doc.documentElement as unknown as SVGSVGElement;
    svg.removeAttribute('color'); // the color comes from the class (currentColor)
    parsedShapes.set(key, svg);
  }
  return svg;
}

/** An icon in the given shape and color. Decorative unless a label is given (the name is shown or set as aria-label nearby). */
function iconSvg(shape: unknown, color: unknown, size: number, extraClass = 'bot-icon'): SVGSVGElement {
  const svg = document.importNode(shapeTemplate(shape), true);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('class', `${extraClass} ${colorClass(color)}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  return svg;
}

const botIcon = (b: Bot, size: number): SVGSVGElement => iconSvg(b.shape, b.color, size);

/** A room's mark: its first two or three bots' icons in a small cluster. */
function roomMark(r: Room): HTMLElement {
  const members = roomMembers(r).slice(0, 3);
  const cluster = node('span', `cluster n${Math.max(2, members.length)}`);
  for (const b of members) cluster.append(botIcon(b, 25));
  return cluster;
}

/** Decide what the main area shows (see view.ts). */
function applyView(): void {
  const view = decideView({
    botCount: activeBots().length, formOpen: state.formOpen, roomFormOpen: state.roomFormOpen,
    settingsOpen: state.settingsOpen, policyOpen: state.policyOpen, aboutOpen: state.aboutOpen, setup: state.setup,
  });
  // The edit modal reuses the create form, shown over the chat.
  const editing = state.editBotId !== null && view === 'chat';
  el.formView.hidden = view !== 'form' && !editing;
  el.formView.classList.toggle('edit-modal', editing);
  el.roomFormView.hidden = view !== 'room-form';
  el.settingsView.hidden = view !== 'settings';
  el.policyView.hidden = view !== 'policy';
  el.aboutView.hidden = view !== 'about';
  el.setupView.hidden = view !== 'setup';
  el.chatView.hidden = view !== 'chat';
  if (view !== 'chat') closePlusMenu();
  el.botCancel.hidden = activeBots().length === 0 && !editing; // nothing to go back to on first run
  if (view === 'setup') renderSetup();
  if (view === 'chat') renderChat();
  if (view === 'settings') renderSettings();
  if (view === 'policy') renderPolicy();
  if (view === 'about') renderAbout();
  reportOpenBot(view === 'chat' && state.roomId === null ? state.botId : null);
  reportOpenRoom(view === 'chat' ? state.roomId : null);
}

let reportedOpenRoom: number | null | undefined;
function reportOpenRoom(roomId: number | null): void {
  if (roomId === reportedOpenRoom) return;
  reportedOpenRoom = roomId;
  api.reportOpenRoom(roomId);
}

/** Main skips the routine notice when that bot's chat is already open in the focused window. */
let reportedOpenBot: number | null | undefined;
function reportOpenBot(botId: number | null): void {
  if (botId === reportedOpenBot) return;
  reportedOpenBot = botId;
  api.reportOpenBot(botId);
}

// ---------- setup screen ----------
let setupPoll: number | undefined;
function renderSetup(): void {
  const st = state.setup;
  const copy = setupCopy(st);
  el.setupText.textContent = copy.text;
  el.setupProgress.hidden = !copy.showProgress;
  if (st.percent === null) el.setupProgress.removeAttribute('value');
  else el.setupProgress.value = st.percent;
  el.setupDetail.hidden = copy.detail === null;
  el.setupDetail.textContent = copy.detail ?? '';
  el.setupGetEngine.hidden = !copy.showGetEngine;
  el.setupRetry.hidden = copy.retryLabel === null;
  el.setupRetry.textContent = copy.retryLabel ?? '';
  // While the engine is missing, keep checking quietly so setup continues once it's installed and running.
  window.clearTimeout(setupPoll);
  if (st.phase === 'engine-missing') setupPoll = window.setTimeout(() => void api.startSetup(), 5000);
}

function onSetupState(st: SetupState): void {
  state.setup = st;
  if (state.lock.locked) return;
  applyView();
}

// ---------- left column: bot icons, then rooms ----------
function railButton(cls: string, label: string, active: boolean, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `rail-btn ${cls}${active ? ' active' : ''}`;
  btn.title = label;
  btn.setAttribute('aria-label', label);
  if (active) btn.setAttribute('aria-current', 'true');
  btn.addEventListener('click', onClick);
  return btn;
}

/** v1.20: Liz's mute icon on a muted bot or room in the dock. */
function muteMark(): HTMLImageElement {
  const img = document.createElement('img');
  img.src = 'assets/cipher-mute.svg'; img.alt = 'Muted'; img.title = 'Muted: no tray notices';
  img.width = 20; img.height = 20; img.className = 'mute-mark';
  return img;
}

function nameMatches(hay: string, q: string): boolean {
  if (!q) return true;
  return hay.toLowerCase().includes(q);
}

function renderRail(): void {
  const showingChat = !state.formOpen && !state.roomFormOpen && !state.settingsOpen && !state.policyOpen && !state.aboutOpen;
  const q = state.searchQuery.trim().toLowerCase();
  const botButton = (b: Bot): HTMLButtonElement => {
    const working = state.speakingBots.has(b.id);
    const btn = railButton(`bot${working ? ' working' : ''}`, b.toolsEnabled ? `${b.name} (reads files)` : b.name, showingChat && b.id === state.botId, () => void selectBot(b.id));
    btn.addEventListener('contextmenu', (e) => void onItemContextMenu(e, 'bot', b.id));
    btn.append(botIcon(b, 42), node('span', 'rail-name', b.name));
    btn.draggable = true;
    btn.dataset.botId = String(b.id);
    btn.addEventListener('dragstart', (e) => { e.dataTransfer?.setData('application/x-cipher-bot', String(b.id)); if (e.dataTransfer) e.dataTransfer.effectAllowed = 'link'; });
    btn.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('application/x-cipher-bot')) { e.preventDefault(); e.dataTransfer.dropEffect = 'link'; btn.classList.add('drop-target'); } });
    btn.addEventListener('dragleave', () => btn.classList.remove('drop-target'));
    btn.addEventListener('drop', (e) => {
      e.preventDefault(); btn.classList.remove('drop-target');
      const raw = e.dataTransfer?.getData('application/x-cipher-bot') ?? '';
      if (/^\d+$/.test(raw)) void roomFromDrag(Number(raw), b.id);
    });
    btn.title = `${btn.title}. Drag onto another bot to start a room.`;
    if (b.muted) btn.append(muteMark());
    addUnreadDot(btn, b.unread && !(showingChat && b.id === state.botId));
    if (!nameMatches(b.name, q)) btn.classList.add('filtered-out');
    return btn;
  };
  // v1.24: dock folders (collapsible) and the tag filter.
  renderTagFilter();
  el.botList.replaceChildren(...dockSections(activeBots(), state.tagFilter, state.groupsCollapsed).flatMap((sec) => {
    if (!sec.group) return sec.bots.map(botButton);
    const head = document.createElement('button');
    head.type = 'button'; head.className = 'dock-group-head';
    head.setAttribute('aria-expanded', String(!sec.collapsed));
    head.title = `${sec.collapsed ? 'Show' : 'Hide'} folder ${sec.group} (${sec.bots.length})`;
    head.setAttribute('aria-label', head.title);
    head.append(node('span', 'ico ico-dock-folders'), node('span', 'rail-name', sec.group));
    head.addEventListener('click', () => void toggleGroup(sec.group));
    const box = node('div', 'dock-group');
    box.append(head, ...(sec.collapsed ? [] : sec.bots.map(botButton)));
    return [box];
  }));
  el.roomList.replaceChildren(...activeRooms().map((r) => {
    const label = `Room: ${roomName(r)}`;
    const btn = railButton('room', label, showingChat && r.id === state.roomId, () => void selectRoom(r.id));
    btn.addEventListener('contextmenu', (e) => void onItemContextMenu(e, 'room', r.id));
    btn.append(roomMark(r), node('span', 'rail-name', roomName(r)));
    if (r.muted) btn.append(muteMark());
    addUnreadDot(btn, r.unread && !(showingChat && r.id === state.roomId));
    if (!nameMatches(roomName(r), q) && !nameMatches(r.name, q)) btn.classList.add('filtered-out');
    return btn;
  }));
  el.openSettings.classList.toggle('active', state.settingsOpen || state.policyOpen || state.aboutOpen);
  renderDock();
}

/** v1.17: the bot dock expanded (icons and names) or collapsed (icons only; unread dots still show). */
function renderDock(): void {
  const collapsed = state.prefs.dockCollapsed;
  document.body.classList.toggle('dock-collapsed', collapsed);
  el.dockToggle.setAttribute('aria-expanded', String(!collapsed));
  const label = collapsed ? 'Expand the bot dock' : 'Collapse the bot dock';
  el.dockToggle.setAttribute('aria-label', label);
  el.dockToggle.title = label;
}

async function setUiPref(name: 'showTimes' | 'dockCollapsed' | 'reduceMotion' | 'compact', value: boolean): Promise<void> {
  state.prefs = await api.setUiPref(name, value);
  applyMotion();
  renderRail();
  if (name === 'showTimes' && !el.chatView.hidden) renderChat();
  el.timesSwitch.checked = state.prefs.showTimes;
  applyCompact();
  if (name === 'compact' && !el.chatView.hidden) renderChat();
}

/** v1.16: a small accent dot on a bot or room with a reply the user hasn't opened yet. */
function addUnreadDot(btn: HTMLButtonElement, unread: boolean): void {
  if (!unread) return;
  btn.classList.add('unread');
  btn.append(node('span', 'unread-dot'));
  btn.setAttribute('aria-label', `${btn.getAttribute('aria-label') ?? ''} (new reply)`);
}

/** v1.16: opening a bot or room clears its dot, here and in the database. */
function clearUnread(kind: 'bot' | 'room', id: number): void {
  const item = kind === 'bot' ? state.bots.find((b) => b.id === id) : state.rooms.find((r) => r.id === id);
  if (!item?.unread) return;
  item.unread = false;
  void api.markRead(kind, id).catch(() => undefined);
}

async function loadBots(): Promise<void> {
  state.bots = await api.listBots();
  renderRail();
}

async function loadRooms(): Promise<void> {
  state.rooms = await api.listRooms();
  renderRail();
}

/** Open a bot's one chat (created on first open). */
async function selectBot(botId: number): Promise<void> {
  closePlusMenu();
  state.formOpen = false;
  state.editBotId = null;
  state.roomFormOpen = false;
  state.settingsOpen = false;
  state.policyOpen = false;
  state.roomId = null;
  state.pendingAttach = null;
  state.quote = null;
  state.pendingImage = null;
  state.images.clear();
  clearAttachError();
  state.aboutOpen = false;
  state.botId = botId;
  clearUnread('bot', botId);
  state.chat = await api.openBotChat(botId);
  state.messages = await api.listMessages(state.chat.id);
  state.routine = await api.getRoutine(botId);
  state.activity = '';
  void refreshActivity();
  state.live = '';
  state.error = null;
  renderRail();
  applyView(); // renders the chat once it's visible, so scrolling to the latest message works
  if (!el.chatView.hidden) el.input.focus();
}

async function selectRoom(roomId: number): Promise<void> {
  closePlusMenu();
  state.formOpen = false;
  state.editBotId = null;
  state.roomFormOpen = false;
  state.settingsOpen = false;
  state.policyOpen = false;
  state.routine = null;
  state.botId = null;
  state.chat = null;
  state.pendingAttach = null;
  state.quote = null;
  state.pendingImage = null;
  state.images.clear();
  clearAttachError();
  state.aboutOpen = false;
  state.roomId = roomId;
  clearUnread('room', roomId);
  state.roomMessages = await api.listRoomMessages(roomId);
  state.error = null;
  renderRail();
  applyView();
  if (!el.chatView.hidden) el.input.focus();
}

// ---------- chat view (a bot's chat or a room) ----------
/** A read_file call (the only tool shown as "Reading file"); search and calculator have their own rows. */
const isFileCall = (c: { function?: { name?: string } }): boolean => !c.function?.name || c.function.name === 'read_file';

function toolCallLabel(m: Message): string {
  return (m.toolCalls ?? []).filter(isFileCall).map((c) => {
    const p = (c.function?.arguments as { path?: unknown })?.path;
    return typeof p === 'string' ? p : '';
  }).join(', ');
}

// ---------- opened pages, multi-select (v1.19) ----------
/** Must match PAGE_BLOCK_START in main/pageFetch.ts. */
const PAGE_BLOCK_START = '--- Opened page: ';

/** A page opened as text: its address and title, with the text folded away. */
function pageRow(m: Message): HTMLElement {
  const first = m.content.split('\n', 1)[0];
  const url = first.slice(PAGE_BLOCK_START.length).replace(/ ---$/, '');
  const card = node('div', 'msg page-card');
  const head = node('div', 'search-head');
  const icon = document.createElement('img');
  icon.src = 'assets/cipher-search-result.svg'; icon.alt = ''; icon.width = 20; icon.height = 20; icon.className = 'search-icon';
  head.append(icon, node('span', undefined, 'Opened page as text'));
  const details = document.createElement('details');
  const sum = document.createElement('summary');
  sum.textContent = url;
  const body = node('pre', 'page-text', m.content.split('\n').slice(1, -1).join('\n'));
  details.append(sum, body);
  card.append(head, details);
  addTime(card, m.createdAt);
  return card;
}

function selectable(row: HTMLElement, id: number): HTMLElement {
  const wrap = node('label', 'select-row');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.className = 'select-box';
  box.checked = state.selected.has(id);
  box.setAttribute('aria-label', 'Select message');
  box.addEventListener('change', () => { if (box.checked) state.selected.add(id); else state.selected.delete(id); renderSelectBar(); });
  wrap.append(box, row);
  return wrap;
}

function renderSelectBar(): void {
  el.selectBar.hidden = !state.selecting;
  el.selectCount.textContent = `${state.selected.size} selected`;
  el.selectDelete.disabled = state.selected.size === 0;
}

function startSelecting(): void {
  state.selecting = true;
  state.selected.clear();
  renderChat();
}

function stopSelecting(): void {
  state.selecting = false;
  state.selected.clear();
  renderChat();
}

async function deleteSelected(): Promise<void> {
  const chat = state.chat;
  if (!chat || !state.selected.size) return;
  try {
    const r = await api.deleteMessages(chat.id, [...state.selected]);
    if (r.canceled) return;
    state.messages = state.messages.filter((m) => !state.selected.has(m.id));
    stopSelecting();
    if (r.undoId) showUndo(r.undoId, `Deleted ${r.deleted} message${r.deleted === 1 ? '' : 's'}.`);
  } catch (err) {
    showAttachError(plainError(err));
  }
}

// ---------- web search (v1.18) ----------
/** The confirm card: the exact query, Search and Cancel. Nothing is sent before Search. */
function searchAskCard(id: string, query: string): HTMLElement {
  const card = node('div', 'msg search-ask');
  card.setAttribute('role', 'group');
  card.setAttribute('aria-label', 'Confirm web search');
  const head = node('div', 'search-head');
  const icon = document.createElement('img');
  icon.src = 'assets/cipher-online-on.svg'; icon.alt = ''; icon.width = 20; icon.height = 20; icon.className = 'search-icon';
  head.append(icon, node('strong', undefined, 'Search the web for:'));
  const q = node('div', 'search-query', query);
  const note = node('p', 'muted search-note', 'Only these words are sent, to DuckDuckGo (which also sees your IP address). Nothing is sent unless you press Search.');
  const row = node('div', 'row end');
  const cancel = document.createElement('button');
  cancel.type = 'button'; cancel.className = 'secondary'; cancel.textContent = 'Cancel';
  const go = document.createElement('button');
  go.type = 'button'; go.textContent = 'Search';
  const answer = (ok: boolean) => { go.disabled = true; cancel.disabled = true; void api.answerSearch(id, ok).catch(() => undefined); };
  cancel.addEventListener('click', () => answer(false));
  go.addEventListener('click', () => answer(true));
  row.append(cancel, go);
  card.append(head, q, note, row);
  return card;
}

/** A stored web_search tool message: the results with source links, or why no search was made. */
function searchResultRow(m: Message): HTMLElement {
  if (!m.search) {
    const why = m.content.startsWith('User did not confirm') ? 'Search cancelled: nothing was sent.'
      : m.content.startsWith('Online is off') ? 'No search: Online is off.'
        : `The web search did not work${/failed \((.*)\)\. Answer/.exec(m.content)?.[1] ? `: ${/failed \((.*)\)\. Answer/.exec(m.content)![1]}` : '.'}`;
    return node('div', 'msg note', why);
  }
  const card = node('div', 'msg search-results');
  const head = node('div', 'search-head');
  const icon = document.createElement('img');
  icon.src = 'assets/cipher-search-result.svg'; icon.alt = ''; icon.width = 20; icon.height = 20; icon.className = 'search-icon';
  head.append(icon, node('span', undefined, `Web search: "${m.search.query}"`));
  card.append(head);
  if (!m.search.results.length) card.append(node('p', 'muted', 'No results.'));
  const list = node('ol', 'search-list');
  for (const r of m.search.results) {
    const li = node('li');
    const link = document.createElement('button');
    link.type = 'button'; link.className = 'link-btn'; link.textContent = r.title; link.title = r.url;
    link.addEventListener('click', () => void api.openLink(r.url).catch((err) => showAttachError(plainError(err))));
    // v1.19: open the page as text in this chat (main asks first, showing the URL).
    const asText = document.createElement('button');
    asText.type = 'button'; asText.className = 'link-btn page-open'; asText.textContent = 'Open as text';
    asText.addEventListener('click', () => {
      if (!state.chat) return;
      asText.disabled = true;
      void api.openPage(state.chat.id, r.url).catch((err) => showAttachError(plainError(err))).finally(() => { asText.disabled = false; });
    });
    li.append(link, node('div', 'search-url', r.url), node('div', 'search-snippet', r.snippet), asText);
    list.append(li);
  }
  card.append(list);
  addTime(card, m.createdAt);
  return card;
}

/** v1.19: reload Last search and the history from main (on Settings open and whenever a search is sent). */
function refreshSearchInfo(): void {
  void api.lastSearch().then((t) => { state.lastSearch = t; if (state.settingsOpen) renderSettings(); }).catch(() => undefined);
  void api.searchHistory().then(renderSearchHistory).catch(() => undefined);
}

/** v1.19: Settings → Search history (local, newest first). */
function renderSearchHistory(list: { id: number; query: string; searchedAt: string }[]): void {
  el.searchHistory.replaceChildren(...list.slice(0, 50).map((h) => {
    const li = node('li');
    li.append(node('span', 'history-query', h.query),
      node('span', 'muted history-time', new Date(h.searchedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })));
    return li;
  }));
  el.searchHistoryEmpty.hidden = list.length > 0;
  el.searchHistoryClear.disabled = list.length === 0;
}

function onSearchAsk(a: { id: string; chatId: number; query: string }): void {
  state.searchAsks.set(a.id, { chatId: a.chatId, query: a.query });
  if (state.chat?.id === a.chatId && !el.chatView.hidden) renderChat();
}

function onSearchClosed(e: { id: string }): void {
  if (state.searchAsks.delete(e.id) && !el.chatView.hidden) renderChat();
}

// ---------- copy a message ----------
const SVG_NS = 'http://www.w3.org/2000/svg';
/** The small copy icon (two overlapping rounded squares), built with DOM calls (no inline styles). */
/** A user or bot message bubble: text and time only (v1.25; actions sit behind the bubble plus) (and a "Routine" tag for routine messages). */
const MD_OPTS = {
  // Links in chat text use the same main-side check as result links, plus a confirm showing the URL.
  onLink: (url: string) => void api.openLink(url, true).catch((err) => showAttachError(plainError(err))),
  onCopy: (text: string) => void api.copyText(text).catch(() => undefined),
};

function bubble(cls: string, text: string, fromRoutine: boolean | string = false, createdAt?: string): HTMLElement {
  const msg = node('div', `msg ${cls}`);
  if (fromRoutine) msg.append(node('span', 'routine-tag', typeof fromRoutine === 'string' ? fromRoutine : 'Routine'));
  if (cls === 'assistant') {
    // v1.19: markdown, built as DOM nodes (text only, raw HTML stays text, no images).
    const md = node('div', 'msg-text md');
    md.append(renderMarkdown(text, MD_OPTS));
    msg.append(md);
    addTime(msg, createdAt);
    return msg;
  }
  msg.append(node('span', 'msg-text', text));
  addTime(msg, createdAt);
  return msg;
}

// ---------- v1.25: the bubble plus menu ----------
interface BubbleItem { label: string; icon?: string; ico?: string; run: () => void; pressed?: boolean; cls?: string }
let openBubbleMenu: HTMLElement | null = null;

function closeBubbleMenu(): void {
  if (!openBubbleMenu) return;
  const host = openBubbleMenu.closest('.msg');
  host?.classList.remove('menu-open');
  host?.querySelector('.bubble-plus')?.setAttribute('aria-expanded', 'false');
  openBubbleMenu.remove();
  openBubbleMenu = null;
}

/** The small plus on a bubble. Its menu is built only when opened, so no action row exists by default. */
function bubblePlus(items: () => BubbleItem[]): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'bubble-plus'; btn.title = 'Message actions';
  btn.setAttribute('aria-label', 'Message actions'); btn.setAttribute('aria-haspopup', 'menu'); btn.setAttribute('aria-expanded', 'false');
  btn.append(node('span', 'ico ico-bubble-plus'));
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const host = btn.closest('.msg') as HTMLElement | null;
    const wasOpen = host?.classList.contains('menu-open');
    closeBubbleMenu();
    if (!host || wasOpen) return;
    const menu = node('div', 'bubble-menu');
    menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', 'Message actions');
    for (const it of items()) {
      const b = document.createElement('button');
      b.type = 'button'; b.setAttribute('role', 'menuitem'); b.className = `bubble-item${it.cls ? ` ${it.cls}` : ''}`;
      b.title = it.label; b.setAttribute('aria-label', it.label);
      if (it.pressed !== undefined) b.setAttribute('aria-pressed', String(it.pressed));
      if (it.icon) { const img = document.createElement('img'); img.src = it.icon; img.alt = ''; img.width = 18; img.height = 18; b.append(img); }
      if (it.ico) b.append(node('span', `ico ${it.ico}`));
      if (!it.cls?.includes('react-btn')) b.append(node('span', 'bubble-item-label', it.label));
      b.addEventListener('click', (ev) => { ev.stopPropagation(); closeBubbleMenu(); it.run(); });
      menu.append(b);
    }
    host.classList.add('menu-open');
    btn.setAttribute('aria-expanded', 'true');
    host.append(menu);
    openBubbleMenu = menu;
    (menu.querySelector('button') as HTMLButtonElement | null)?.focus();
  });
  return btn;
}

function withPlus(row: HTMLElement, items: () => BubbleItem[]): HTMLElement { row.append(bubblePlus(items)); return row; }

async function copyMessage(text: string): Promise<void> {
  try { await api.copyText(text); } catch (err) { showAttachError(plainError(err)); }
}

function roomMenuItems(text: string): () => BubbleItem[] {
  return () => [
    { label: 'Copy', ico: 'ico-copy-msg', run: () => void copyMessage(text) },
    { label: readingText === text ? 'Stop reading' : 'Read aloud', ico: 'ico-read-aloud', run: () => readAloud(text) },
  ];
}

function botMenuItems(row: HTMLElement, m: Message, chatId: number): () => BubbleItem[] {
  return () => {
    const items: BubbleItem[] = [
      { label: 'Quote', icon: 'assets/cipher-quote.svg', run: () => { state.quote = { id: m.id, text: m.content }; renderQuoteUi(); el.input.focus(); } },
      { label: m.pinned ? 'Unpin' : 'Pin', icon: 'assets/cipher-pin.svg', cls: m.pinned ? 'on' : '', run: () => void togglePin(chatId, m.id, !m.pinned) },
      ...REACTION_CHOICES.map((c) => ({ label: c.label, ico: `ico-react-${c.id}`, cls: 'react-btn', pressed: m.reaction === c.id, run: () => void react(chatId, m, c.id) })),
      { label: 'Copy', ico: 'ico-copy-msg', run: () => void copyMessage(m.content) },
    ];
    if (m.role === 'user' && !m.content.startsWith(PAGE_BLOCK_START)) items.push({ label: 'Edit', run: () => startEdit(row, m, chatId) });
    items.push(
      { label: 'Delete', run: () => void deleteOne(chatId, m.id) },
      { label: 'Save to memory', icon: 'assets/cipher-memory.svg', run: () => void rememberMessage(chatId, m.id) },
      { label: readingText === m.content ? 'Stop reading' : 'Read aloud', ico: 'ico-read-aloud', run: () => readAloud(m.content) },
    );
    if (m.edited) items.push({ label: 'Edit history', run: () => void openEdits(chatId, m.id) });
    return items;
  };
}

async function react(chatId: number, m: Message, id: string): Promise<void> {
  try {
    const upd = await api.reactMessage(chatId, m.id, m.reaction === id ? null : id);
    const cur = state.messages.find((x) => x.id === m.id);
    if (cur) cur.reaction = upd.reaction ?? null;
    renderChat();
  } catch (err) { state.error = plainError(err); renderChat(); }
}

async function deleteOne(chatId: number, id: number): Promise<void> {
  try {
    const r = await api.deleteMessages(chatId, [id]); // main asks first
    if (r.canceled) return;
    state.messages = state.messages.filter((x) => x.id !== id);
    renderChat();
    if (r.undoId) showUndo(r.undoId, 'Deleted 1 message.');
  } catch (err) { showAttachError(plainError(err)); }
}

// ---------- v1.25: read aloud (voices on this computer only) ----------
let readingText: string | null = null;
function readAloud(text: string): void {
  const synth = window.speechSynthesis;
  if (readingText === text) { synth.cancel(); readingText = null; return; }
  synth.cancel();
  const voice = localVoices(synth.getVoices())[0];
  if (!voice) { showAttachError('No voice on this computer is available for read-aloud. Nothing was sent anywhere.'); return; }
  const u = new SpeechSynthesisUtterance(text);
  u.voice = voice; // a local voice only; never a network voice
  u.onend = () => { if (readingText === text) readingText = null; };
  readingText = text;
  synth.speak(u);
}

// ---------- v1.25: hold-to-talk (local whisper.cpp, run by main) ----------
let voice: VoiceState = { engine: null, model: null, tested: '' };
let micStream: MediaStream | null = null;
let micCtx: AudioContext | null = null;
let micChunks: Float32Array[] = [];
let micBusy = false;

function renderVoice(): void {
  const ready = !!voice.engine && !!voice.model;
  el.mic.hidden = !ready;
  el.voiceTested.textContent = voice.tested;
  el.voiceEngine.textContent = voice.engine ?? 'Not chosen';
  el.voiceModel.textContent = voice.model ?? 'Not chosen';
  el.voiceClear.hidden = !voice.engine && !voice.model;
}

async function voiceCall(f: () => Promise<VoiceState>): Promise<void> {
  el.voiceError.hidden = true;
  try { voice = await f(); } catch (err) { el.voiceError.textContent = plainError(err); el.voiceError.hidden = false; }
  renderVoice();
}

/** Stop the mic: every track ends, the audio graph closes. Called on release, blur and lock. */
function releaseMic(): void {
  micStream?.getTracks().forEach((t) => t.stop());
  micStream = null;
  void micCtx?.close().catch(() => undefined);
  micCtx = null;
  el.mic.classList.remove('recording');
  el.mic.setAttribute('aria-pressed', 'false');
  el.mic.setAttribute('aria-label', 'Hold to talk');
}

async function micDown(): Promise<void> {
  if (micStream || micBusy || el.mic.hidden) return;
  micChunks = [];
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch { showAttachError('The microphone is not available.'); return; }
  micCtx = new AudioContext({ sampleRate: 16000 });
  const src = micCtx.createMediaStreamSource(micStream);
  const proc = micCtx.createScriptProcessor(4096, 1, 1);
  proc.onaudioprocess = (e) => { if (micStream) micChunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
  src.connect(proc); proc.connect(micCtx.destination);
  el.mic.classList.add('recording');
  el.mic.setAttribute('aria-pressed', 'true');
  el.mic.setAttribute('aria-label', 'Recording');
}

async function micUp(): Promise<void> {
  if (!micStream) return;
  releaseMic();
  const total = micChunks.reduce((n, c) => n + c.length, 0);
  const all = new Float32Array(total);
  let o = 0; for (const c of micChunks) { all.set(c, o); o += c.length; }
  micChunks = [];
  if (total < 1600) return; // under 0.1 s
  micBusy = true; el.mic.classList.add('busy');
  try {
    const text = await api.transcribe(floatToPcm16(all));
    if (text) {
      const cur = el.input.value;
      el.input.value = cur ? `${cur}${/\s$/.test(cur) ? '' : ' '}${text}` : text;
      el.input.dispatchEvent(new Event('input'));
      el.input.focus();
    }
  } catch (err) { showAttachError(plainError(err)); }
  finally { micBusy = false; el.mic.classList.remove('busy'); }
}

el.mic.addEventListener('pointerdown', (e) => { e.preventDefault(); el.mic.setPointerCapture(e.pointerId); void micDown(); });
el.mic.addEventListener('pointerup', () => void micUp());
el.mic.addEventListener('pointercancel', () => void micUp());
el.mic.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); void micDown(); } });
el.mic.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); void micUp(); } });
el.mic.addEventListener('blur', () => void micUp());
window.addEventListener('blur', () => releaseMic());
document.addEventListener('click', (e) => { if (openBubbleMenu && !openBubbleMenu.contains(e.target as Node)) closeBubbleMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeBubbleMenu(); });
el.voicePickEngine.addEventListener('click', () => void voiceCall(() => api.pickVoiceEngine()));
el.voicePickModel.addEventListener('click', () => void voiceCall(() => api.pickVoiceModel()));
el.voiceClear.addEventListener('click', () => void voiceCall(() => api.clearVoice()));

// ---------- v1.25: file drafts (nothing is written until Save and the confirm in main) ----------
let drafts: DraftInfo[] = [];
let draftsChat: number | null = null;
async function loadDrafts(): Promise<void> {
  const chatId = state.chat?.id ?? null;
  draftsChat = chatId;
  drafts = chatId === null ? [] : await api.listDrafts(chatId).catch(() => []);
  if (!el.chatView.hidden && state.roomId === null) renderChat();
}

function draftCard(d: DraftInfo, chatId: number): HTMLElement {
  const card = node('div', 'msg note draft-card');
  card.append(node('strong', '', `Draft file: ${d.path}`), node('pre', 'draft-preview', d.content.length > 1200 ? `${d.content.slice(0, 1199)}…` : d.content));
  card.append(node('p', 'muted', 'Nothing is written until you press Save and confirm.'));
  const save = document.createElement('button'); save.type = 'button'; save.textContent = 'Save…';
  const discard = document.createElement('button'); discard.type = 'button'; discard.className = 'secondary'; discard.textContent = 'Discard';
  save.addEventListener('click', () => {
    save.disabled = true;
    void api.saveDraft(chatId, d.id).catch((err) => showAttachError(plainError(err))).finally(() => void loadDrafts());
  });
  discard.addEventListener('click', () => void api.discardDraft(chatId, d.id).finally(() => void loadDrafts()));
  const bar = node('div', 'row end'); bar.append(discard, save);
  card.append(bar);
  return card;
}
api.onDrafts((chatId) => { if (state.chat?.id === chatId) void loadDrafts(); });

// ---------- v1.25: weekly report (counts only, made on this computer) ----------
el.reportOpen.addEventListener('click', () => {
  el.reportMsg.hidden = true;
  void api.weeklyReport().then((t) => { el.reportText.textContent = t; el.reportModal.hidden = false; el.reportClose.focus(); })
    .catch((err) => showAttachError(plainError(err)));
});
el.reportClose.addEventListener('click', () => { el.reportModal.hidden = true; });
el.reportSave.addEventListener('click', () => {
  void api.saveWeeklyReport().then((r) => {
    if (r.ok) { el.reportMsg.textContent = `Saved to ${r.path}`; el.reportMsg.hidden = false; }
  }).catch((err) => { el.reportMsg.textContent = plainError(err); el.reportMsg.hidden = false; });
});

// ---------- v1.25: compact mode, memory search ----------
function applyCompact(): void {
  document.documentElement.classList.toggle('compact', state.prefs.compact === true);
  el.compactSwitch.checked = state.prefs.compact === true;
}
el.compactSwitch.addEventListener('change', () => void setUiPref('compact', el.compactSwitch.checked));

function renderMemorySearch(): void {
  const hits = searchMemory(el.botMemory.value, el.memorySearch.value);
  const q = el.memorySearch.value.trim();
  el.memoryResults.replaceChildren(...(q && !hits.length ? [node('li', 'muted', 'No match in this memory note.')] : hits.map((h) => {
    const li = document.createElement('li');
    const b = document.createElement('button'); b.type = 'button'; b.className = 'link-btn';
    b.textContent = `Line ${h.line}: ${clip(h.text, 120)}`;
    b.addEventListener('click', () => {
      const lines = el.botMemory.value.split('\n');
      const startAt = lines.slice(0, h.line - 1).reduce((n, l) => n + l.length + 1, 0);
      el.botMemory.focus(); el.botMemory.setSelectionRange(startAt, startAt + lines[h.line - 1].length);
    });
    li.append(b);
    return li;
  })));
}
el.memorySearch.addEventListener('input', renderMemorySearch);

// ---------- v1.25: drag a bot onto another to start a room ----------
async function roomFromDrag(fromId: number, toId: number): Promise<void> {
  if (fromId === toId) return;
  const a = botById(fromId); const b = botById(toId);
  if (!a || !b) return;
  try {
    const room = await api.createRoom({ name: '', botIds: [toId, fromId] });
    await loadRooms();
    await selectRoom(room.id);
  } catch (err) { showAttachError(plainError(err)); }
}

// ---------- v1.20: quote, pin, image in a bot's chat ----------
const QUOTE_PREVIEW = 160;
const clip = (t: string, n: number): string => { const one = t.replace(/\s+/g, ' ').trim(); return one.length > n ? `${one.slice(0, n - 1)}…` : one; };

function iconButton(icon: string, label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = `msg-act ${cls}`; btn.title = label; btn.setAttribute('aria-label', label);
  const img = document.createElement('img');
  img.src = icon; img.alt = ''; img.width = 20; img.height = 20;
  btn.append(img);
  btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return btn;
}

/** Quote block above the text, the picture (from its bytes, via main), and Quote / Pin buttons. */
function decorateMessage(row: HTMLElement, m: Message, chatId: number): void {
  row.dataset.mid = String(m.id);
  if (m.pinned) row.classList.add('pinned');
  if (m.quote) {
    const q = node('blockquote', 'msg-quote', clip(m.quote, QUOTE_PREVIEW * 2));
    row.prepend(q);
  }
  if (m.image) {
    const img = document.createElement('img');
    img.className = 'msg-image'; img.alt = m.image.split(/[\\/]/).pop() ?? 'Image';
    const cached = state.images.get(m.id);
    img.tabIndex = 0; img.title = 'View larger';
    img.addEventListener('click', () => openImageViewer(img));
    img.addEventListener('keydown', (e) => { if (e.key === 'Enter') openImageViewer(img); });
    if (cached) img.src = cached;
    else if (cached === null) { row.append(node('span', 'muted image-missing', `Image not available: ${img.alt}`)); }
    if (cached !== null) {
      row.insertBefore(img, row.querySelector('.msg-text'));
      if (cached === undefined) void api.getImage(chatId, m.id).then((url) => {
        // Only a data: URL with an image type is ever used as a source (never a remote address).
        const ok = typeof url === 'string' && /^data:image\/(png|jpeg|gif|webp);base64,/.test(url);
        state.images.set(m.id, ok ? url : null);
        if (ok) img.src = url; else { img.remove(); row.append(node('span', 'muted image-missing', `Image not available: ${img.alt}`)); }
      }).catch(() => { state.images.set(m.id, null); img.remove(); });
    }
  }
  // v1.25: text and time only; everything else sits behind the small plus on the bubble.
  if (m.role === 'assistant' && state.showTps && state.tps.has(m.id)) row.append(node('div', 'tps-line', state.tps.get(m.id)!));
  const n = reactionCount(m.reaction);
  if (n && m.reaction) {
    const badge = node('span', 'react-count');
    badge.title = `Reaction: ${REACTION_CHOICES.find((c) => c.id === m.reaction)?.label ?? m.reaction}`;
    badge.append(node('span', `ico ico-react-${m.reaction}`), node('span', 'react-n', String(n)));
    row.append(badge);
  }
  if (m.edited) row.append(node('span', 'edited-tag', 'edited'));
  row.append(bubblePlus(botMenuItems(row, m, chatId)));
}

async function togglePin(chatId: number, id: number, on: boolean): Promise<void> {
  try {
    const pinned = await api.pinMessage(chatId, id, on);
    const ids = new Set(pinned.map((p) => p.id));
    for (const m of state.messages) m.pinned = ids.has(m.id);
    renderChat();
  } catch (err) { state.error = plainError(err); renderChat(); }
}

function renderPinnedStrip(chatId: number): void {
  const pinned = state.messages.filter((m) => m.pinned);
  el.pinnedStrip.hidden = pinned.length === 0;
  el.pinnedStrip.replaceChildren(...pinned.map((m) => {
    const item = node('div', 'pinned-item');
    const icon = document.createElement('img');
    icon.src = 'assets/cipher-pin.svg'; icon.alt = ''; icon.width = 20; icon.height = 20;
    const go = document.createElement('button');
    go.type = 'button'; go.className = 'pinned-go'; go.textContent = clip(m.content || (m.image ? 'Image' : ''), 90); go.title = 'Show this message';
    go.addEventListener('click', () => {
      const row = el.messages.querySelector(`[data-mid="${m.id}"]`);
      row?.scrollIntoView({ block: 'center' });
      row?.classList.add('flash'); window.setTimeout(() => row?.classList.remove('flash'), 1200);
    });
    const un = document.createElement('button');
    un.type = 'button'; un.className = 'secondary small'; un.textContent = '×'; un.title = 'Unpin'; un.setAttribute('aria-label', 'Unpin');
    un.addEventListener('click', () => void togglePin(chatId, m.id, false));
    item.append(icon, go, un);
    return item;
  }));
}

function renderQuoteUi(): void {
  el.quoteChip.hidden = !state.quote || state.roomId !== null;
  el.quoteChipText.textContent = state.quote ? clip(state.quote.text, QUOTE_PREVIEW) : '';
  el.imageChip.hidden = !state.pendingImage || state.roomId !== null;
  if (state.pendingImage) {
    el.imageChipPreview.src = state.pendingImage.dataUrl;
    el.imageChipName.textContent = state.pendingImage.relPath.startsWith('pasted:') ? 'Pasted image' : state.pendingImage.relPath;
  } else el.imageChipPreview.removeAttribute('src');
}

/** v1.17: the message's local time under its text, when "Show message times" is on. */
function addTime(msg: HTMLElement, createdAt?: string): void {
  const t = state.prefs.showTimes && createdAt ? formatMessageTime(createdAt) : '';
  if (t) msg.append(node('span', 'msg-time', t));
}

function renderChat(): void {
  if (state.roomId !== null) renderRoom();
  else renderBotChat();
  if (!el.findBar.hidden) applyFind(false);
}

function setComposer(busy: boolean, placeholder: string): void {
  el.send.hidden = busy;
  el.stop.hidden = !busy;
  el.input.placeholder = placeholder;
}

function renderBotChat(): void {
  const bot = currentBot();
  const chat = state.chat;
  if (!bot || !chat) return;
  // Header: the bot's icon and name only (everything else is in the plus menu).
  el.chatIcon.hidden = false;
  el.chatIcon.replaceChildren(botIcon(bot, 40));
  el.chatBotName.textContent = bot.name;
  el.chatActivity.textContent = state.activity;

  const q = state.searchQuery.trim().toLowerCase();
  const items: HTMLElement[] = [];
  for (const m of state.messages) {
    const match = !q || m.content.toLowerCase().includes(q);
    let row: HTMLElement | null = null;
    if (m.role === 'user') row = m.content.startsWith(PAGE_BLOCK_START) ? pageRow(m) : bubble('user', m.content, m.reminder ? 'Reminder' : m.routine, m.createdAt);
    else if (m.role === 'assistant') {
      if (m.content) row = bubble('assistant', m.content, false, m.createdAt);
      if (m.toolCalls?.some(isFileCall)) {
        const note = node('div', 'msg note', `Reading file: ${toolCallLabel(m)}`);
        if (!match) note.classList.add('search-hidden');
        items.push(note);
      }
    } else if (m.toolName === 'web_search') {
      row = searchResultRow(m);
    } else if (m.toolName === 'calculator') {
      row = node('div', `msg note${m.content.startsWith('Error:') ? ' bad' : ''}`, `Calculator: ${m.content}`);
    } else if (m.toolName === 'draft_file') {
      // v1.25: the draft is kept in main; nothing was written (the Save card below does that, after a confirm).
      row = node('div', `msg note${m.content.startsWith('Error:') ? ' bad' : ''}`, `Draft file: ${m.content}`);
    } else if (m.toolName === 'write_file' || m.toolName === 'checklist_add') {
      // v1.22: the outcome main reported (written, cancelled or refused), as plain text.
      const ok = /^(Wrote|Added)/.test(m.content);
      row = node('div', `msg note${ok ? '' : ' bad'}`, `${m.toolName === 'write_file' ? 'Write file' : 'Checklist'}: ${m.content}`);
    } else {
      const bad = m.content.startsWith('Error:');
      row = node('div', `msg note${bad ? ' bad' : ''}`, bad ? `Couldn't read the file: ${m.content.slice(7)}` : `Read ${m.content.length} characters from the file`);
    }
    if (row) {
      if ((m.role === 'user' || m.role === 'assistant') && row.classList.contains('msg') && !row.classList.contains('note')) decorateMessage(row, m, chat.id);
      if (!match) row.classList.add('search-hidden');
      if (state.selecting) row = selectable(row, m.id);
      items.push(row);
    }
  }
  const busy = state.busy.has(chat.id);
  renderSelectBar();
  for (const [id, a] of state.searchAsks) if (a.chatId === chat.id) items.push(searchAskCard(id, a.query));
  if (draftsChat === chat.id) for (const d of drafts) items.push(draftCard(d, chat.id));
  else void loadDrafts();
  if (busy) items.push(node('div', 'msg assistant live', state.live));
  if (state.error) items.push(node('div', 'msg error', state.error));
  if (!items.length) items.push(node('div', 'msg note', `Say hello to ${bot.name}.`));
  el.messages.replaceChildren(...items);
  el.messages.scrollTop = el.messages.scrollHeight;
  renderPinnedStrip(chat.id);
  renderQuoteUi();
  setComposer(busy, CHAT_PLACEHOLDER);
  renderAttachUi(true);
}

/** A room reply: the speaking bot's icon + name, then the text. */
function roomReply(botId: number | null, text: string, live = false, createdAt?: string): HTMLElement {
  const bot = botById(botId);
  const msg = node('div', `msg assistant room-msg${live ? ' live' : ''}`);
  const speaker = node('div', 'speaker');
  if (bot) speaker.append(botIcon(bot, 26));
  speaker.append(node('span', 'name', bot ? bot.name : 'Cipher bot'));
  msg.append(speaker, node('div', 'text', text));
  if (!live) msg.append(bubblePlus(roomMenuItems(text)));
  addTime(msg, createdAt);
  return msg;
}

function renderRoom(): void {
  const room = currentRoom();
  if (!room) return;
  el.pinnedStrip.hidden = true; // pins and quotes are for a bot's chat
  state.quote = null;
  renderQuoteUi();
  const members = roomMembers(room);
  // Header: the room name only.
  el.chatIcon.hidden = true;
  el.chatIcon.replaceChildren();
  el.chatBotName.textContent = roomName(room);
  el.chatActivity.textContent = '';

  const q = state.searchQuery.trim().toLowerCase();
  const items: HTMLElement[] = [];
  for (const m of state.roomMessages) {
    const match = !q || m.content.toLowerCase().includes(q);
    const row = m.role === 'user' ? withPlus(bubble('user', m.content, false, m.createdAt), roomMenuItems(m.content)) : roomReply(m.botId, m.content, false, m.createdAt);
    if (!match) row.classList.add('search-hidden');
    items.push(row);
  }
  const live = state.roomLive.get(room.id);
  if (live && live.botId !== null) items.push(roomReply(live.botId, live.text, true));
  if (state.error) items.push(node('div', 'msg error', state.error));
  if (!items.length) {
    items.push(node('div', 'msg note', `Say hello to ${members.map((b) => b.name).join(', ')}. Each Cipher bot replies once, in this order; type @Name to ask just one.`));
  }
  el.messages.replaceChildren(...items);
  el.messages.scrollTop = el.messages.scrollHeight;
  setComposer(!!live, ROOM_PLACEHOLDER);
  renderAttachUi(false); // attach is 1:1 only
}

function updateLive(): void {
  const live = el.messages.querySelector('.msg.live');
  if (live && state.roomId === null) {
    live.textContent = state.live;
    el.messages.scrollTop = el.messages.scrollHeight;
  } else if (live && state.roomId !== null) {
    const text = live.querySelector('.text');
    if (text) text.textContent = state.roomLive.get(state.roomId)?.text ?? '';
    el.messages.scrollTop = el.messages.scrollHeight;
  } else renderChat();
}

const plainError = (e: unknown): string =>
  e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e);

async function send(): Promise<void> {
  const text = el.input.value.trim();
  if (state.roomId !== null) {
    if (!text) return;
    const roomId = state.roomId;
    if (state.roomLive.has(roomId)) return;
    state.error = null;
    state.roomLive.set(roomId, { botId: null, text: '' });
    el.input.value = '';
    renderChat();
    try {
      await api.sendRoomMessage(roomId, text);
      playSendSound();
    } catch (e) {
      state.roomLive.delete(roomId);
      state.error = plainError(e);
      el.input.value = text;
      renderChat();
    }
    return;
  }
  const chat = state.chat;
  if (!chat || state.busy.has(chat.id)) return;
  const attachBlock = state.pendingAttach?.block ?? null;
  const image = state.pendingImage;
  const quote = state.quote;
  let outgoing = attachBlock ? (text ? `${text}\n\n${attachBlock}` : attachBlock) : text;
  if (!outgoing.trim() && image) outgoing = 'Here is an image.';
  if (!outgoing.trim()) return;
  state.error = null;
  state.live = '';
  state.busy.add(chat.id);
  if (state.botId != null) { state.speakingBots.add(state.botId); renderRail(); }
  el.input.value = '';
  const clearedAttach = state.pendingAttach;
  state.pendingAttach = null;
  state.quote = null;
  state.pendingImage = null;
  renderChat();
  try {
    await api.sendMessage(chat.id, outgoing, { ...(quote ? { quoteId: quote.id } : {}), ...(image ? { image: image.relPath } : {}) });
    playSendSound();
  } catch (e) {
    state.busy.delete(chat.id);
    if (state.botId != null) { state.speakingBots.delete(state.botId); renderRail(); }
    state.error = plainError(e);
    el.input.value = text;
    state.pendingAttach = clearedAttach;
    state.quote = quote;
    state.pendingImage = image;
    renderChat();
  }
}

function speakingBotForChat(chatId: number): number | null {
  const chat = state.chat?.id === chatId ? state.chat : null;
  if (chat) return chat.botId;
  // Events for a chat that isn't open (a routine or the phone): its bot isn't known here, so no dot.
  return null;
}

async function onChatEvent(ev: ChatEvent): Promise<void> {
  // A reply this window didn't start (a routine or the phone) still shows as replying (live text, Stop).
  if (ev.type === 'token' || ev.type === 'tool') state.busy.add(ev.chatId);
  if (ev.type === 'token' || ev.type === 'message' || ev.type === 'tool') {
    const botId = speakingBotForChat(ev.chatId);
    if (botId != null) { state.speakingBots.add(botId); renderRail(); }
  }
  if (ev.type === 'done' || ev.type === 'error') {
    state.busy.delete(ev.chatId);
    const botId = speakingBotForChat(ev.chatId);
    if (botId != null) { state.speakingBots.delete(botId); renderRail(); }
  }
  if (state.roomId !== null || ev.chatId !== state.chat?.id) return;
  switch (ev.type) {
    case 'token': {
      state.live += ev.text;
      const run = state.tpsRun.get(ev.chatId) ?? { start: performance.now(), tokens: 0 };
      run.tokens++; state.tpsRun.set(ev.chatId, run);
      updateLive();
      return;
    }
    case 'message':
      if (ev.message.role === 'assistant' && ev.message.content) {
        const run = state.tpsRun.get(ev.chatId);
        const t = run ? tokensPerSecond(run.tokens, performance.now() - run.start) : null;
        if (t) state.tps.set(ev.message.id, t);
        state.tpsRun.delete(ev.chatId);
        void refreshActivity();
      }
      state.messages.push(ev.message);
      if (ev.message.role === 'assistant') state.live = '';
      if (ev.message.role === 'user' && state.chat && state.chat.title === 'New chat') {
        state.chat = await api.openBotChat(state.chat.botId); // picks up the title from the first message
      }
      break;
    case 'tool':
      return; // the tool message event that follows renders it
    case 'error':
      state.error = ev.error;
      state.live = '';
      void api.checkSetup(); // if the engine stopped or setup is incomplete, the setup screen offers the fix
      break;
    case 'done':
      state.live = '';
      break;
  }
  renderChat();
}

/** Room rounds: the same handling as single chats (friendly errors, Stop keeps what was streamed). */
function onRoomEvent(ev: RoomEvent): void {
  const live = state.roomLive.get(ev.roomId);
  const viewing = ev.roomId === state.roomId;
  switch (ev.type) {
    case 'speaker':
      if (live?.botId != null) state.speakingBots.delete(live.botId);
      state.roomLive.set(ev.roomId, { botId: ev.botId, text: '' });
      state.speakingBots.add(ev.botId);
      renderRail();
      break;
    case 'token':
      if (live) live.text += ev.text;
      if (viewing) updateLive();
      return;
    case 'message':
      if (ev.message.role === 'assistant' && live) {
        if (live.botId != null) state.speakingBots.delete(live.botId);
        live.botId = null; live.text = '';
        renderRail();
      }
      if (viewing) state.roomMessages.push(ev.message);
      break;
    case 'error':
      if (live?.botId != null) state.speakingBots.delete(live.botId);
      state.roomLive.delete(ev.roomId);
      renderRail();
      if (viewing) state.error = ev.error;
      void api.checkSetup();
      break;
    case 'done':
      if (live?.botId != null) state.speakingBots.delete(live.botId);
      state.roomLive.delete(ev.roomId);
      renderRail();
      break;
  }
  if (viewing) renderChat();
}

// ---------- create a Cipher bot (name, job, icon shape + color) ----------
function pickedShape(): string {
  return (el.shapePicker.querySelector('input:checked') as HTMLInputElement | null)?.value ?? BOT_SHAPES[0];
}
function pickedColor(): string {
  return (el.colorPicker.querySelector('input:checked') as HTMLInputElement | null)?.value ?? DEFAULT_COLOR;
}

/** Recolor the shape picker's icons to the picked color. */
function recolorShapePicker(): void {
  const cls = colorClass(pickedColor());
  for (const svg of el.shapePicker.querySelectorAll('svg')) svg.setAttribute('class', `bot-icon ${cls}`);
}

function buildPickers(): void {
  el.shapePicker.replaceChildren(...BOT_SHAPES.map((shape) => {
    const label = node('label', 'shape-opt') as HTMLLabelElement;
    label.title = SHAPE_LABELS[shape];
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'shape';
    input.value = shape;
    input.className = 'sr-only';
    input.setAttribute('aria-label', SHAPE_LABELS[shape]);
    label.append(input, iconSvg(shape, DEFAULT_COLOR, 46));
    return label;
  }));
  el.colorPicker.replaceChildren(...BOT_COLORS.map((color) => {
    const label = node('label', `color-opt ${colorClass(color)}`) as HTMLLabelElement;
    label.title = COLOR_LABELS[color];
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'color';
    input.value = color;
    input.className = 'sr-only';
    input.setAttribute('aria-label', COLOR_LABELS[color]);
    label.append(input, node('span', 'swatch'));
    return label;
  }));
  el.colorPicker.addEventListener('change', recolorShapePicker);
}

function resetPickers(): void {
  const shape = leastUsedShape(state.bots.map((b) => b.shape)); // so a new bot looks different by default
  for (const i of el.shapePicker.querySelectorAll('input')) (i as HTMLInputElement).checked = i.value === shape;
  for (const i of el.colorPicker.querySelectorAll('input')) (i as HTMLInputElement).checked = i.value === colorOf(DEFAULT_COLOR);
  recolorShapePicker();
}

/** Labels for the shared bot form: "Create a Cipher bot" or "Edit <name>". */
function setBotFormMode(editName: string | null): void {
  el.botFormTitle.textContent = editName === null ? 'Create a Cipher bot' : `Edit ${editName}`;
  el.botSubmit.textContent = editName === null ? 'Create Cipher bot' : 'Save';
  el.botFormArt.hidden = editName !== null;
  el.botMemoryWrap.hidden = editName === null; // v1.19: memory note is edited in the bot's settings
  el.memorySearchWrap.hidden = editName === null; // v1.25: search inside this bot's memory
  el.starterJobs.hidden = editName !== null; // v1.20: starter jobs only when creating
  el.replyLengthWrap.hidden = editName === null; // v1.21: reply length in the bot's settings
}

function openBotForm(): void {
  el.form.reset();
  resetPickers();
  setBotFormMode(null);
  el.botFormError.hidden = true;
  state.editBotId = null;
  state.formOpen = true;
  state.roomFormOpen = false;
  state.settingsOpen = false;
  state.nameTouched = false;
  fillGroupList();
  renderRail();
  applyView();
  el.botName.focus();
}

/** Edit a Cipher bot: the create form, prefilled, shown as a modal over the chat. */
function openEditBot(): void {
  const bot = currentBot();
  if (!bot) return;
  el.form.reset();
  el.botName.value = bot.name;
  el.botJob.value = bot.systemPrompt;
  el.botMemory.value = bot.memoryNote;
  el.memorySearch.value = ''; renderMemorySearch();
  el.replyLength.value = bot.replyLength;
  el.botTags.value = (bot.tags ?? []).join(', ');
  el.botGroup.value = bot.group ?? '';
  state.nameTouched = true;
  fillGroupList();
  // A bad stored shape/color shows (and saves) as the default, same as everywhere else.
  const shape = shapeOf(bot.shape);
  const color = colorOf(bot.color);
  for (const i of el.shapePicker.querySelectorAll('input')) (i as HTMLInputElement).checked = i.value === shape;
  for (const i of el.colorPicker.querySelectorAll('input')) (i as HTMLInputElement).checked = i.value === color;
  recolorShapePicker();
  setBotFormMode(bot.name);
  el.botFormError.hidden = true;
  state.editBotId = bot.id;
  applyView();
  el.botName.focus();
}

function closeEditBot(): void {
  if (state.editBotId === null) return;
  state.editBotId = null;
  applyView();
}

async function submitBotForm(e: Event): Promise<void> {
  e.preventDefault();
  el.botFormError.hidden = true;
  const form = { name: el.botName.value, job: el.botJob.value, shape: shapeOf(pickedShape()), color: colorOf(pickedColor()) };
  if (state.editBotId !== null) {
    try {
      let updated = await api.updateBot(state.editBotId, form);
      if (el.botMemory.value.trim() !== updated.memoryNote) updated = await api.setBotMemory(updated.id, el.botMemory.value);
      if (el.replyLength.value !== updated.replyLength) updated = await api.setReplyLength(updated.id, el.replyLength.value as Bot['replyLength']);
      updated = await saveTagsAndGroup(updated);
      state.editBotId = null;
      applyView();
      await replaceBot(updated); // the left column and the chat header update right away
    } catch (err) {
      el.botFormError.textContent = plainError(err);
      el.botFormError.hidden = false;
    }
    return;
  }
  try {
    const bot = await saveTagsAndGroup(await api.createBot(form));
    state.formOpen = false;
    await loadBots();
    await selectBot(bot.id);
  } catch (err) {
    el.botFormError.textContent = plainError(err);
    el.botFormError.hidden = false;
  }
}

// ---------- create a room (2+ bots, optional name) ----------
function openRoomForm(): void {
  el.roomForm.reset();
  el.roomFormError.hidden = true;
  el.roomMembers.replaceChildren(...activeBots().map((b) => {
    const label = node('label', 'row member-opt') as HTMLLabelElement;
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = String(b.id);
    label.append(box, botIcon(b, 30), node('span', 'name', b.name));
    return label;
  }));
  const tooFew = activeBots().length < 2;
  el.roomCreate.disabled = tooFew;
  if (tooFew) {
    el.roomFormError.textContent = 'Create at least two Cipher bots first.';
    el.roomFormError.hidden = false;
  }
  state.roomFormOpen = true;
  state.formOpen = false;
  state.settingsOpen = false;
  renderRail();
  applyView();
  el.roomName.focus();
}

async function submitRoomForm(e: Event): Promise<void> {
  e.preventDefault();
  el.roomFormError.hidden = true;
  const botIds = [...el.roomMembers.querySelectorAll('input:checked')].map((i) => Number((i as HTMLInputElement).value));
  if (botIds.length < 2) {
    el.roomFormError.textContent = 'Pick at least two Cipher bots for the room.';
    el.roomFormError.hidden = false;
    return;
  }
  try {
    const room = await api.createRoom({ name: el.roomName.value, botIds });
    state.roomFormOpen = false;
    await loadRooms();
    await selectRoom(room.id);
  } catch (err) {
    el.roomFormError.textContent = plainError(err);
    el.roomFormError.hidden = false;
  }
}

function closeForms(): void {
  state.formOpen = false;
  state.policyOpen = false;
  state.aboutOpen = false;
  state.editBotId = null;
  state.roomFormOpen = false;
  state.settingsOpen = false;
  renderRail();
  applyView();
}

function openSettings(): void {
  state.aboutOpen = false;
  refreshSearchInfo(); // reloaded every time Settings opens, so Last search can't go stale
  void api.getLockState().then((ls) => { state.lock = ls; if (state.settingsOpen) renderLockSettings(); });
  for (const p of [el.lockMsg, el.lockError, el.backupMsg, el.backupError, el.restoreError]) p.hidden = true;
  state.settingsOpen = true;
  state.policyOpen = false;
  void refreshDisk();
  void refreshV124Settings();
  state.editBotId = null;
  state.formOpen = false;
  state.roomFormOpen = false;
  renderRail();
  applyView();
}

function renderSettings(): void {
  renderLockSettings();
  el.onlineSwitch.checked = state.online;
  el.soundSwitch.checked = state.sendSound;
  el.onlineState.textContent = state.online ? 'Online is on: web search is available (after you press Search).' : 'Online is off: nothing is sent to the internet.';
  el.onlineOnIcon.hidden = !state.online;
  el.lastSearch.textContent = state.lastSearch ? new Date(state.lastSearch).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'never';
  el.timesSwitch.checked = state.prefs.showTimes;
  applyCompact();
  void voiceCall(() => api.voiceState());
  el.settingsVersion.textContent = state.version;
  const ph = state.phone;
  el.phoneStart.hidden = ph.running;
  el.phoneStop.hidden = !ph.running;
  el.phoneRefresh.hidden = !ph.running;
  el.phoneStatus.hidden = !ph.running || !ph.pairingCode;
  if (ph.pairingCode) {
    el.phoneCode.textContent = ph.pairingCode;
    const ms = (ph.pairingExpiresAt ?? 0) - Date.now();
    el.phoneExpiry.textContent = ms > 0 ? ` · expires in ~${Math.ceil(ms / 60000)} min` : ' · expired';
    const showQr = !!(ph.qrDataUrl && ph.primaryUrl);
    el.phoneQrWrap.hidden = !showQr;
    if (showQr) {
      el.phoneQr.src = ph.qrDataUrl!;
      el.phonePrimaryUrl.textContent = ph.primaryUrl!;
    }
    el.phoneUrls.replaceChildren(...ph.urls.map((u) => {
      const li = document.createElement('li');
      const code = document.createElement('code');
      code.className = 'cmd';
      code.textContent = u;
      if (ph.primaryUrl && u === ph.primaryUrl) {
        const mark = document.createElement('span');
        mark.className = 'muted';
        mark.textContent = ' (QR)';
        li.append(code, mark);
      } else {
        li.append(code);
      }
      return li;
    }));
  } else {
    el.phoneQrWrap.hidden = true;
  }
}

// ---------- Settings: lock, backup, restore (v1.13) ----------
// Passphrases are read from the field, the field is cleared, and the value goes to main once (never stored here).
function renderLockSettings(): void {
  const on = state.lock.enabled;
  el.lockStatus.textContent = on ? 'The lock is on.' : 'The lock is off.';
  el.lockStatus.classList.toggle('on', on);
  el.lockSetForm.hidden = on;
  el.lockChangeForm.hidden = !on;
  el.lockOffForm.hidden = !on;
}

function lockFeedback(ok: string | null, error: string | null): void {
  el.lockMsg.textContent = ok ?? '';
  el.lockMsg.hidden = ok === null;
  el.lockError.textContent = error ?? '';
  el.lockError.hidden = error === null;
}

/** Read and clear password fields. */
function takeValues(...inputs: HTMLInputElement[]): string[] {
  const values = inputs.map((i) => i.value);
  for (const i of inputs) i.value = '';
  return values;
}

async function submitLockSet(e: Event): Promise<void> {
  e.preventDefault();
  const [pass, confirm] = takeValues(el.lockSetNew, el.lockSetConfirm);
  if (pass.length < 8) { lockFeedback(null, 'The passphrase must be at least 8 characters.'); return; }
  if (pass !== confirm) { lockFeedback(null, 'The two passphrases don\'t match.'); return; }
  try {
    state.lock = await api.enableLock(pass, confirm);
    renderLockSettings();
    lockFeedback('The lock is on. Cipher Bot will lock when its window is closed to the tray or next time it starts.', null);
  } catch (err) {
    lockFeedback(null, plainError(err));
  }
}

function lockResultMessage(r: UnlockResult, ok: string): void {
  if (r.ok) lockFeedback(ok, null);
  else lockFeedback(null, r.error);
}

async function submitLockChange(e: Event): Promise<void> {
  e.preventDefault();
  const [current, pass, confirm] = takeValues(el.lockChangeCurrent, el.lockChangeNew, el.lockChangeConfirm);
  if (pass.length < 8) { lockFeedback(null, 'The new passphrase must be at least 8 characters.'); return; }
  if (pass !== confirm) { lockFeedback(null, 'The two new passphrases don\'t match.'); return; }
  try {
    lockResultMessage(await api.changeLock(current, pass, confirm), 'Passphrase changed.');
  } catch (err) {
    lockFeedback(null, plainError(err));
  }
}

async function submitLockOff(e: Event): Promise<void> {
  e.preventDefault();
  const [current] = takeValues(el.lockOffCurrent);
  try {
    const r = await api.disableLock(current);
    if (r.ok) state.lock = await api.getLockState();
    renderLockSettings();
    lockResultMessage(r, 'The lock is off.');
  } catch (err) {
    lockFeedback(null, plainError(err));
  }
}

async function backupNow(): Promise<void> {
  el.backupMsg.hidden = true;
  el.backupError.hidden = true;
  el.backupBtn.disabled = true;
  try {
    const r = await api.backup();
    if (r.ok) { el.backupMsg.textContent = `Backup saved: ${r.path}`; el.backupMsg.hidden = false; }
    else if (!r.canceled) { el.backupError.textContent = r.error; el.backupError.hidden = false; }
  } catch (err) {
    el.backupError.textContent = plainError(err);
    el.backupError.hidden = false;
  } finally {
    el.backupBtn.disabled = false;
  }
}

async function restoreNow(): Promise<void> {
  el.restoreError.hidden = true;
  const showError = (msg: string) => { el.restoreError.textContent = msg; el.restoreError.hidden = false; };
  let r;
  try { r = await api.pickRestore(); } catch (err) { showError(plainError(err)); return; }
  if (!r.ok) { if (!r.canceled) showError(r.error); return; }
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  openConfirm(
    `Restore from "${r.file}"?`,
    `This replaces all your current Cipher bots, chats, rooms and routines with the ones in this backup ` +
      `(${n(r.bots, 'Cipher bot', 'Cipher bots')}, ${n(r.rooms, 'room', 'rooms')}). ` +
      'Before replacing, Cipher Bot saves a copy of the current database next to it (cipher.db.before-restore-<date>-<time>), then restarts. ' +
      'The lock on this computer stays as it is, and Online is turned off.',
    async () => {
      try { await api.confirmRestore(); } catch (err) { showError(plainError(err)); }
    },
    'Restore and restart',
  );
}

// ---------- lock screen (v1.13) ----------
// Full-window overlay, shown by default in the HTML (fails closed). While locked the window holds no chat data:
// main refuses every data request and sends no chat events; locking again reloads the page.
let unlockRetryTimer: number | undefined;
function showLockScreen(): void {
  releaseMic(); // v1.25: the mic stream ends on lock
  window.speechSynthesis?.cancel();
  el.lockScreen.hidden = false;
  el.lockPassError.hidden = true;
  el.lockPass.focus();
}

function hideLockScreen(): void {
  el.lockScreen.hidden = true;
  el.lockPass.value = '';
  el.lockPassError.hidden = true;
}

async function submitUnlock(e: Event): Promise<void> {
  e.preventDefault();
  const [pass] = takeValues(el.lockPass);
  el.lockUnlock.disabled = true;
  let r: UnlockResult;
  try {
    r = await api.unlock(pass);
  } catch (err) {
    r = { ok: false, error: plainError(err), waitMs: 0 };
  }
  if (r.ok) {
    el.lockUnlock.disabled = false;
    state.lock = await api.getLockState();
    hideLockScreen();
    await loadAppData();
    return;
  }
  el.lockPassError.textContent = r.error;
  el.lockPassError.hidden = false;
  window.clearTimeout(unlockRetryTimer);
  unlockRetryTimer = window.setTimeout(() => { el.lockUnlock.disabled = false; el.lockPass.focus(); }, r.waitMs);
  el.lockPass.focus();
}

// ---------- policy (read-only; text lives in policy.ts) ----------
function renderPolicy(): void {
  el.policyTitle.textContent = POLICY_TITLE;
  const parts: HTMLElement[] = [];
  for (const section of POLICY_SECTIONS) {
    parts.push(node('h3', undefined, section.heading));
    for (const p of section.paragraphs) parts.push(node('p', undefined, p));
  }
  el.policyBody.replaceChildren(...parts);
  el.policyContact.textContent = POLICY_CONTACT;
}

function openPolicy(): void {
  state.policyOpen = true;
  state.aboutOpen = false;
  state.settingsOpen = false;
  state.formOpen = false;
  state.roomFormOpen = false;
  state.editBotId = null;
  renderRail();
  applyView();
  el.policyView.scrollTop = 0;
}

function closePolicy(): void {
  state.policyOpen = false;
  openSettings();
}

// ---------- About (v1.16): icon, name, version from main, and the in-app Policy screen ----------
function renderAbout(): void {
  el.aboutVersion.textContent = state.version;
  el.whatsNew.replaceChildren(...WHATS_NEW.slice(0, 5).map((line) => node('li', undefined, line)));
}

function openAbout(): void {
  state.aboutOpen = true;
  state.settingsOpen = false;
  state.policyOpen = false;
  state.formOpen = false;
  state.roomFormOpen = false;
  state.editBotId = null;
  renderRail();
  applyView();
}

// ---------- send sound (v1.16): bundled assets/send.wav, only when the Settings switch is on ----------
let sendAudio: HTMLAudioElement | null = null;
function playSendSound(): void {
  if (!state.sendSound) return;
  sendAudio ??= new Audio('assets/send.wav');
  sendAudio.currentTime = 0;
  void sendAudio.play().catch(() => undefined);
}

// ---------- routine (one per bot; runs in main while Cipher is open or in the tray) ----------
function openRoutine(): void {
  const bot = currentBot();
  if (!bot) return;
  const r = state.routine && state.routine.botId === bot.id ? state.routine : null;
  el.routineTitle.textContent = `Routine for ${bot.name}`;
  el.routinePrompt.value = r?.prompt ?? '';
  el.routineTime.value = r?.time ?? '08:00';
  el.routineEnabled.checked = r ? r.enabled : true;
  el.routineError.hidden = true;
  el.routineModal.hidden = false;
  el.routinePrompt.focus();
}

function closeRoutine(): void {
  el.routineModal.hidden = true;
}

async function submitRoutine(e: Event): Promise<void> {
  e.preventDefault();
  const bot = currentBot();
  if (!bot) return;
  el.routineError.hidden = true;
  try {
    const saved = await api.setRoutine(bot.id, { prompt: el.routinePrompt.value, time: el.routineTime.value, enabled: el.routineEnabled.checked });
    if (state.botId === bot.id) state.routine = saved;
    closeRoutine();
    renderChat();
  } catch (err) {
    el.routineError.textContent = plainError(err);
    el.routineError.hidden = false;
  }
}

function onPhoneStatus(s: PhoneLinkStatus): void {
  state.phone = s;
  if (state.settingsOpen) renderSettings();
}


async function replaceBot(updated: Bot): Promise<void> {
  state.bots = state.bots.map((b) => (b.id === updated.id ? updated : b));
  renderRail();
  renderChat();
}

// ---------- attach (desktop 1:1 only) ----------
function renderAttachUi(botMode: boolean): void {
  const show = botMode && !!state.botId;
  if (!el.plusMenu.hidden) renderPlusMenu(); // keep Attach's busy state current while the menu is open
  if (state.pendingAttach && show) {
    el.attachChip.hidden = false;
    el.attachChipName.textContent = state.pendingAttach.relPath;
  } else {
    el.attachChip.hidden = true;
  }
}

function clearAttachError(): void {
  el.attachError.hidden = true;
  el.attachError.textContent = '';
}

function showAttachError(msg: string): void {
  el.attachError.textContent = msg;
  el.attachError.hidden = false;
}

async function attachFile(): Promise<void> {
  clearAttachError();
  const bot = currentBot();
  if (!bot || state.roomId !== null) return;
  if (!bot.folderPath) {
    const folder = await api.pickFolder();
    if (!folder) {
      showAttachError('Choose a folder for this Cipher bot before attaching a file.');
      return;
    }
    await replaceBot(await api.setBotFolder(bot.id, folder));
  }
  const result = await api.pickAttachFile(bot.id);
  if (!result.ok) {
    if (result.needFolder) {
      showAttachError(result.error);
      return;
    }
    if (result.error !== 'No file selected.') showAttachError(result.error);
    return;
  }
  state.pendingAttach = { relPath: result.relPath, block: result.block };
  renderAttachUi(true);
}

// ---------- delete bot (confirm required) ----------
type ConfirmAction = (() => void | Promise<void>) | null;
let pendingConfirm: ConfirmAction = null;

function openConfirm(title: string, body: string, onOk: () => void | Promise<void>, okLabel = 'Delete'): void {
  el.confirmTitle.textContent = title;
  el.confirmBody.textContent = body;
  el.confirmOk.textContent = okLabel;
  pendingConfirm = onOk;
  el.confirmModal.hidden = false;
  el.confirmOk.focus();
}

function closeConfirm(): void {
  el.confirmModal.hidden = true;
  pendingConfirm = null;
}

async function requestDeleteBot(botId: number | null = state.botId): Promise<void> {
  const bot = botById(botId);
  if (!bot) return;
  const inRooms = state.rooms.filter((r) => r.memberIds.includes(bot.id));
  const roomNote = inRooms.length
    ? ` It will also be removed from ${inRooms.length} room${inRooms.length === 1 ? '' : 's'}; any room left with fewer than 2 Cipher bots will be deleted.`
    : '';
  openConfirm(
    `Delete ${bot.name}?`,
    `This deletes this Cipher bot and its chat history (you can undo for 10 seconds).${roomNote}`,
    async () => {
      const result = await api.deleteBot(bot.id); // refused (error shown) while the bot is replying
      if (result.undoId) showUndo(result.undoId, `Deleted ${bot.name}.`);
      await loadBots();
      await loadRooms();
      // Something else stays open if it still exists; otherwise switch to a remaining chat or the empty state.
      const stillOpen = (state.botId !== null && state.botId !== bot.id && botById(state.botId))
        || (state.roomId !== null && !result.deletedRoomIds.includes(state.roomId) && currentRoom());
      if (stillOpen) { renderRail(); applyView(); }
      else if (activeBots().length) { state.pendingAttach = null; await selectBot(activeBots()[0].id); }
      else {
        state.pendingAttach = null;
        state.roomId = null;
        state.botId = null;
        state.chat = null;
        state.messages = [];
        state.formOpen = true;
        renderRail();
        applyView();
      }
    },
  );
}

// ---------- delete a room (group chat): confirm first; refused while it's replying ----------
function requestDeleteRoom(roomId: number): void {
  const room = state.rooms.find((r) => r.id === roomId);
  if (!room) return;
  const name = roomName(room);
  openConfirm(
    `Delete room "${name}"?`,
    'This deletes this room and its messages (you can undo for 10 seconds). The Cipher bots in it stay, with their own chats.',
    async () => {
      const rr = await api.deleteRoom(room.id); // refused (error shown) while the room is replying
      if (rr && rr.undoId) showUndo(rr.undoId, `Deleted room "${name}".`);
      await loadRooms();
      if (state.roomId === room.id) {
        state.roomId = null;
        state.roomMessages = [];
        if (activeBots().length) await selectBot(activeBots()[0].id);
        else { renderRail(); applyView(); }
      } else {
        renderRail();
      }
    },
    'Delete room',
  );
}

// ---------- right-click a bot or room in the left column: native menu with Delete… ----------
async function onItemContextMenu(e: MouseEvent, kind: 'bot' | 'room', id: number): Promise<void> {
  e.preventDefault();
  const choice = await api.showItemMenu(kind);
  if (choice === 'archive') { void archiveItem(kind, id); return; }
  if (choice !== 'delete') return;
  if (kind === 'bot') void requestDeleteBot(id);
  else requestDeleteRoom(id);
}

// ---------- plus menu (inside the composer): the chat's actions ----------
function currentPlusItems(): PlusItem[] {
  if (state.roomId !== null) return plusMenuItems({ kind: 'room', muted: currentRoom()?.muted === true });
  const bot = currentBot();
  if (!bot) return [];
  return plusMenuItems({
    kind: 'bot', toolsEnabled: bot.toolsEnabled, folderPath: bot.folderPath, secondFolderPath: bot.secondFolderPath,
    busy: state.chat ? state.busy.has(state.chat.id) : false,
    routineTime: state.routine && state.routine.botId === bot.id && state.routine.enabled ? state.routine.time : null,
    muted: bot.muted,
  });
}

function plusMenuButtons(): HTMLButtonElement[] {
  return [...el.plusMenu.querySelectorAll('button')].filter((b) => !b.disabled);
}

function renderPlusMenu(): void {
  const focusedId = (document.activeElement as HTMLElement | null)?.dataset?.item;
  el.plusMenu.replaceChildren(...currentPlusItems().map((item) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'plus-item';
    btn.dataset.item = item.id;
    btn.disabled = item.disabled;
    btn.setAttribute('role', item.checked === undefined ? 'menuitem' : 'menuitemcheckbox');
    if (item.checked !== undefined) btn.setAttribute('aria-checked', String(item.checked));
    btn.append(node('span', 'plus-label', item.label));
    if (item.checked !== undefined) btn.append(node('span', `plus-state${item.checked ? ' on' : ''}`, item.checked ? 'On' : 'Off'));
    if (item.hint) { btn.append(node('span', 'plus-hint', item.hint)); btn.title = item.hint; }
    btn.addEventListener('click', () => { closePlusMenu(); void runPlusItem(item.id); });
    return btn;
  }));
  if (focusedId) (el.plusMenu.querySelector(`[data-item="${focusedId}"]`) as HTMLButtonElement | null)?.focus();
}

function openPlusMenu(): void {
  renderPlusMenu();
  if (!el.plusMenu.childElementCount) return;
  el.plusMenu.hidden = false;
  el.plus.setAttribute('aria-expanded', 'true');
  plusMenuButtons()[0]?.focus();
}

function closePlusMenu(returnFocus = false): void {
  if (el.plusMenu.hidden) return;
  el.plusMenu.hidden = true;
  el.plus.setAttribute('aria-expanded', 'false');
  if (returnFocus) el.plus.focus();
}

/** Each item runs exactly the handler its old header/composer control ran. */
async function runPlusItem(id: PlusItemId): Promise<void> {
  switch (id) {
    case 'attach': return attachFile();
    case 'export': return exportOpenChat();
    case 'clear': return requestClearChat();
    case 'select': return startSelecting();
    case 'edit': return openEditBot();
    case 'folder': return chooseFolder();
    case 'second': return toggleSecondFolder();
    case 'tools': return openTools();
    case 'routine': return openRoutine();
    case 'mute': return toggleMute();
    case 'markdown': return copyMarkdown();
    case 'checklist': return openChecklist();
    case 'reminder': return openReminders();
    case 'summarize': return summarizeFolder();
    case 'archive': return state.roomId !== null ? archiveItem('room', state.roomId) : state.botId !== null ? archiveItem('bot', state.botId) : undefined;
  }
}

// ---------- v1.21: archive, copy as Markdown, image viewer, blocked sites, always on top, tips ----------
async function archiveItem(kind: 'bot' | 'room', id: number, archived = true): Promise<void> {
  try {
    const r = await api.setArchived(kind, id, archived);
    state.bots = r.bots; state.rooms = r.rooms;
    const wasOpen = archived && ((kind === 'bot' && state.botId === id && state.roomId === null) || (kind === 'room' && state.roomId === id));
    if (wasOpen) {
      state.roomId = null; state.botId = null; state.chat = null; state.messages = [];
      const next = activeBots()[0];
      if (next) await selectBot(next.id);
      else { state.formOpen = !state.settingsOpen; renderRail(); applyView(); }
    } else { renderRail(); applyView(); }
    renderArchived();
  } catch (err) { state.error = plainError(err); renderChat(); }
}

function renderArchived(): void {
  const items = [...state.bots.filter((b) => b.archived).map((b) => ({ kind: 'bot' as const, id: b.id, name: b.name })),
    ...state.rooms.filter((r) => r.archived).map((r) => ({ kind: 'room' as const, id: r.id, name: `Room: ${roomName(r)}` }))];
  el.archivedEmpty.hidden = items.length > 0;
  el.archivedList.replaceChildren(...items.map((it) => {
    const li = node('li', 'row archived-item');
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'secondary small'; btn.textContent = 'Restore';
    btn.setAttribute('aria-label', `Restore ${it.name}`);
    btn.addEventListener('click', () => void archiveItem(it.kind, it.id, false));
    li.append(node('span', 'archived-name', it.name), btn);
    return li;
  }));
}

async function copyMarkdown(): Promise<void> {
  const target = state.roomId !== null ? { kind: 'room' as const, id: state.roomId } : state.botId !== null ? { kind: 'bot' as const, id: state.botId } : null;
  if (!target) return;
  try {
    const r = await api.copyMarkdown(target.kind, target.id);
    showAttachError(`Copied the chat as Markdown (${r.chars} characters).`);
    el.attachError.classList.add('ok');
    window.setTimeout(() => { el.attachError.classList.remove('ok'); clearAttachError(); }, 2500);
  } catch (err) { showAttachError(plainError(err)); }
}

/** The larger view shows the same data: URL the bubble already has (never a file or web address). */
function openImageViewer(img: HTMLImageElement): void {
  const src = img.getAttribute('src') ?? '';
  if (!/^data:image\/(png|jpeg|gif|webp);base64,/.test(src)) return;
  el.imageViewerImg.src = src;
  el.imageViewerImg.alt = img.alt;
  el.imageViewerName.textContent = img.alt;
  el.imageViewer.hidden = false;
  el.imageViewerClose.focus();
}
function closeImageViewer(): void {
  el.imageViewer.hidden = true;
  el.imageViewerImg.removeAttribute('src');
}

function renderSites(list: string[]): void {
  el.siteEmpty.hidden = list.length > 0;
  el.siteList.replaceChildren(...list.map((site) => {
    const li = node('li', 'row site-item');
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'secondary small'; btn.textContent = 'Remove'; btn.setAttribute('aria-label', `Unblock ${site}`);
    btn.addEventListener('click', () => void api.removeBlockedSite(site).then(renderSites));
    li.append(node('span', 'site-name', site), btn);
    return li;
  }));
}

function renderAlwaysOnTop(on: boolean): void {
  el.alwaysOnTop.classList.toggle('on', on);
  el.alwaysOnTop.setAttribute('aria-pressed', String(on));
  el.alwaysOnTop.title = on ? 'Always on top: on' : 'Always on top: off';
}

let tipIndex = 0;
function showTip(i: number): void {
  tipIndex = i;
  const t = TIPS[i];
  el.tipIcon.src = t.icon;
  el.tipTitle.textContent = t.title;
  el.tipBody.textContent = t.body;
  el.tipStep.textContent = `${i + 1} of ${TIPS.length}`;
  el.tipNext.textContent = i === TIPS.length - 1 ? 'Done' : 'Next';
  el.tips.hidden = false;
  el.tipNext.focus();
}
function finishTips(): void {
  el.tips.hidden = true;
  void api.tipsDone();
}
async function maybeShowTips(): Promise<void> {
  if (await api.tipsPending().catch(() => false)) showTip(0);
}

/** v1.20: mute the open bot or room (no tray notice while muted). */
async function toggleMute(): Promise<void> {
  if (state.roomId !== null) {
    const r = currentRoom();
    if (r) { r.muted = await api.setMuted('room', r.id, !r.muted); renderRail(); }
    return;
  }
  const b = currentBot();
  if (b) { b.muted = await api.setMuted('bot', b.id, !b.muted); renderRail(); }
}

/** Read files on/off (was the header checkbox). */
async function setTools(enabled: boolean): Promise<void> {
  const bot = currentBot();
  if (bot) await replaceBot(await api.setBotTools(bot.id, enabled));
}

/** Choose folder (was the header button). */
async function chooseFolder(): Promise<void> {
  const bot = currentBot();
  const folder = bot && (await api.pickFolder());
  if (bot && folder) await replaceBot(await api.setBotFolder(bot.id, folder));
}

/** v1.15: attach a second local folder with the folder picker, or remove it. The read folder is not touched. */
async function toggleSecondFolder(): Promise<void> {
  const bot = currentBot();
  if (!bot) return;
  if (bot.secondFolderPath) { await replaceBot(await api.setBotSecondFolder(bot.id, null)); return; }
  const folder = await api.pickFolder();
  if (!folder) return;
  try { await replaceBot(await api.setBotSecondFolder(bot.id, folder)); } catch (err) { showAttachError(plainError(err)); }
}

function onPlusMenuKey(e: KeyboardEvent): void {
  const items = plusMenuButtons();
  const i = items.indexOf(document.activeElement as HTMLButtonElement);
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePlusMenu(true); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
  else if (e.key === 'Home') { e.preventDefault(); items[0]?.focus(); }
  else if (e.key === 'End') { e.preventDefault(); items[items.length - 1]?.focus(); }
}

// ---------- clear chat (confirm required; 1:1 only) ----------
function requestClearChat(): void {
  const bot = currentBot();
  if (!bot || state.roomId !== null) return;
  openConfirm(
    `Clear chat with ${bot.name}?`,
    'This deletes the messages in this chat (you can undo for 10 seconds). The Cipher bot, its settings and its rooms stay.',
    async () => {
      const chat = await api.clearBotChat(bot.id);
      if (chat.undoId) showUndo(chat.undoId, `Cleared the chat with ${bot.name}.`);
      if (state.botId !== bot.id) return;
      state.chat = chat;
      state.messages = [];
      state.live = '';
      state.error = null;
      state.pendingAttach = null;
      clearAttachError();
      renderChat();
    },
    'Clear chat',
  );
}

// ---------- export the open chat or room to a text file ----------
async function exportOpenChat(): Promise<void> {
  const target = state.roomId !== null ? { kind: 'room' as const, id: state.roomId } : state.botId !== null ? { kind: 'bot' as const, id: state.botId } : null;
  if (!target) return;
  try {
    const r = await api.exportChat(target.kind, target.id);
    if (!r.ok && !r.canceled) { state.error = r.error; renderChat(); }
  } catch (err) {
    state.error = plainError(err);
    renderChat();
  }
}

function onSearchInput(): void {
  state.searchQuery = el.search.value;
  renderRail();
  if (!el.chatView.hidden) renderChat();
}

// ---------- wiring ----------
buildPickers();
// The "create a room" button's mark: two muted icons from the set plus a "+" badge (not bot icons, so no animation).
const roomPlusMark = ['hex', 'circle'].map((shape) => {
  const svg = iconSvg(shape, DEFAULT_COLOR, 25);
  svg.setAttribute('class', 'mark c-muted');
  return svg;
});
el.newRoomMark.replaceChildren(...roomPlusMark);
el.newRoomMark.classList.add('n2');
el.newBot.addEventListener('click', openBotForm);
el.newRoom.addEventListener('click', openRoomForm);
el.openSettings.addEventListener('click', openSettings);
el.settingsClose.addEventListener('click', closeForms);
el.openPolicy.addEventListener('click', openPolicy);
el.policyClose.addEventListener('click', closePolicy);
el.openAbout.addEventListener('click', openAbout);
el.aboutPolicy.addEventListener('click', openPolicy);
el.aboutClose.addEventListener('click', openSettings);
el.timesSwitch.addEventListener('change', () => void setUiPref('showTimes', el.timesSwitch.checked));
el.dockToggle.addEventListener('click', () => void setUiPref('dockCollapsed', !state.prefs.dockCollapsed));

// ---------- drag a file onto a 1:1 chat to attach it (v1.17) ----------
// Never let a dropped file load in the window: the default dragover/drop is blocked on the whole document
// (main also blocks will-navigate). Only a drop on an open bot chat does anything, through main's attach checks.
const dropTargetOk = (): boolean => !el.chatView.hidden && state.botId !== null && state.roomId === null;
document.addEventListener('dragover', (e) => {
  e.preventDefault();
  // v1.25: a bot dragged in the dock may only land on another bot (to start a room); never on the chat.
  if (e.dataTransfer?.types.includes('application/x-cipher-bot')) {
    e.dataTransfer.dropEffect = (e.target as Element | null)?.closest?.('#bot-list .rail-btn.bot') ? 'link' : 'none';
    return;
  }
  const onChat = el.chatView.contains(e.target as Node) && !el.chatView.hidden;
  if (e.dataTransfer) e.dataTransfer.dropEffect = onChat && dropTargetOk() ? 'copy' : 'none';
  el.chatView.classList.toggle('drop-over', onChat && dropTargetOk());
});
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) el.chatView.classList.remove('drop-over'); });
document.addEventListener('drop', (e) => {
  e.preventDefault();
  el.chatView.classList.remove('drop-over');
  if (el.chatView.hidden || !el.chatView.contains(e.target as Node)) return;
  void onChatDrop(e.dataTransfer?.files ?? null);
});

async function onChatDrop(files: FileList | null): Promise<void> {
  clearAttachError();
  if (state.roomId !== null) { showAttachError('Files can be attached in a Cipher bot\'s chat, not in rooms.'); return; }
  const bot = currentBot();
  if (!bot || !files || files.length === 0) return;
  if (files.length > 1) { showAttachError('Drop one file at a time.'); return; }
  const filePath = api.pathForFile(files[0]);
  if (!filePath) { showAttachError('Only files from this computer can be attached.'); return; }
  if (/\.(png|jpe?g|gif|webp)$/i.test(filePath)) {
    // v1.20: an image: same folder rules as Attach, checked and read in main, shown from its bytes (data: URL).
    const img = await api.attachDroppedImage(bot.id, filePath);
    if (!img.ok) { showAttachError(img.error); return; }
    state.pendingImage = { relPath: img.relPath, dataUrl: img.dataUrl };
    renderQuoteUi();
    return;
  }
  const result = await api.attachDroppedFile(bot.id, filePath);
  if (!result.ok) { showAttachError(result.error); return; }
  state.pendingAttach = { relPath: result.relPath, block: result.block };
  renderAttachUi(true);
}

el.soundSwitch.addEventListener('change', () => {
  void api.setSendSound(el.soundSwitch.checked).then((on) => { state.sendSound = on; el.soundSwitch.checked = on; });
});
api.onUnreadChanged(() => { void loadBots(); void loadRooms(); });
el.routineCancel.addEventListener('click', closeRoutine);
el.routineForm.addEventListener('submit', (e) => void submitRoutine(e));
el.routineModal.addEventListener('click', (e) => { if (e.target === el.routineModal) closeRoutine(); });
el.botCancel.addEventListener('click', () => { if (state.editBotId !== null) closeEditBot(); else closeForms(); });
el.formView.addEventListener('click', (e) => { if (state.editBotId !== null && e.target === el.formView) closeEditBot(); });
el.plus.addEventListener('click', () => { if (el.plusMenu.hidden) openPlusMenu(); else closePlusMenu(true); });
el.plusMenu.addEventListener('keydown', onPlusMenuKey);
el.plusMenu.addEventListener('focusout', (e) => {
  const to = e.relatedTarget as Node | null;
  if (to && !el.plusMenu.contains(to) && to !== el.plus) closePlusMenu(); // Tab out of the menu closes it
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !el.plusMenu.hidden) { e.preventDefault(); closePlusMenu(true); }
  else if (e.key === 'Escape' && state.quote && document.activeElement === el.input) { e.preventDefault(); state.quote = null; renderQuoteUi(); }
});
document.addEventListener('mousedown', (e) => {
  const t = e.target as Node;
  if (!el.plusMenu.hidden && !el.plusMenu.contains(t) && !el.plus.contains(t)) closePlusMenu();
});
el.roomCancel.addEventListener('click', closeForms);
el.onlineSwitch.addEventListener('change', async () => {
  state.online = await api.setOnline(el.onlineSwitch.checked);
  renderSettings();
});
api.onSearchAsk(onSearchAsk);
api.onSearchSent(() => refreshSearchInfo());
el.searchHistoryClear.addEventListener('click', () => void api.clearSearchHistory().then(renderSearchHistory).catch(() => undefined));
el.selectCancel.addEventListener('click', stopSelecting);
el.selectDelete.addEventListener('click', () => void deleteSelected());
api.onSearchClosed(onSearchClosed);
el.lockForm.addEventListener('submit', (e) => void submitUnlock(e));
el.lockSetForm.addEventListener('submit', (e) => void submitLockSet(e));
el.lockChangeForm.addEventListener('submit', (e) => void submitLockChange(e));
el.lockOffForm.addEventListener('submit', (e) => void submitLockOff(e));
el.backupBtn.addEventListener('click', () => void backupNow());
el.restoreBtn.addEventListener('click', () => void restoreNow());
el.phoneStart.addEventListener('click', async () => { state.phone = await api.startPhoneLink(); renderSettings(); });
el.phoneStop.addEventListener('click', async () => { state.phone = await api.stopPhoneLink(); renderSettings(); });
el.phoneRefresh.addEventListener('click', async () => { state.phone = await api.refreshPhoneLinkCode(); renderSettings(); });
api.onPhoneLink(onPhoneStatus);
el.form.addEventListener('submit', (e) => void submitBotForm(e));
el.roomForm.addEventListener('submit', (e) => void submitRoomForm(e));
el.setupGetEngine.addEventListener('click', () => void api.openEngineDownload());
el.setupRetry.addEventListener('click', () => void api.startSetup());
api.onSetupState(onSetupState);
el.attachClear.addEventListener('click', () => { state.pendingAttach = null; clearAttachError(); renderAttachUi(true); });
el.search.addEventListener('input', onSearchInput);
el.confirmCancel.addEventListener('click', closeConfirm);
el.confirmOk.addEventListener('click', () => {
  const action = pendingConfirm;
  closeConfirm();
  if (action) void Promise.resolve(action()).catch((e) => { state.error = plainError(e); renderChat(); });
});
el.confirmModal.addEventListener('click', (e) => { if (e.target === el.confirmModal) closeConfirm(); });
el.composer.addEventListener('submit', (e) => { e.preventDefault(); void send(); });
el.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void send(); }
});
el.stop.addEventListener('click', () => {
  if (state.roomId !== null) void api.stopRoom(state.roomId);
  else if (state.chat) void api.stop(state.chat.id);
});
api.onChatEvent((ev) => void onChatEvent(ev));
api.onRoomEvent(onRoomEvent);
// Clicking a routine notice: open that bot's chat (after startup has loaded the bots, if it hasn't yet).
let initDone = false;
let pendingOpenBot: number | null = null;
api.onOpenBot((botId) => {
  if (!initDone) { pendingOpenBot = botId; return; }
  if (state.bots.some((b) => b.id === botId)) void selectBot(botId);
});

// ---------- window focus ----------
// Bot icon animations pause while the window is in the background (see .unfocused in styles.css).
const setUnfocused = (unfocused: boolean): void => { document.documentElement.classList.toggle('unfocused', unfocused); };
window.addEventListener('focus', () => setUnfocused(false));
window.addEventListener('blur', () => setUnfocused(true));
setUnfocused(!document.hasFocus()); // sync on load

// ---------- splash ----------
// Shows "Cipher" on every launch for about a second (nothing is stored, so it can't be "already seen"), then fades.
// Loading, setup and the model check run in parallel and never wait on it; it never stays past 1.5 s
// (the CSS also hides it at 1.75 s as a safety net). A window main re-creates later in the same process skips it.
const splashStart = performance.now();
let splashDone = false;
function hideSplash(): void {
  if (splashDone) return;
  splashDone = true;
  el.splash.classList.add('hide');
  window.setTimeout(() => el.splash.remove(), 300);
}
if (!showsSplash(location.hash)) { splashDone = true; el.splash.remove(); }
window.setTimeout(hideSplash, SPLASH_MAX_MS);

/** Load bots, rooms and the first (or notice-requested) chat. Only after the lock check says unlocked. */
async function loadAppData(): Promise<void> {
  try {
    state.setup = await api.getSetup();
    state.online = await api.getOnline();
    state.version = await api.getVersion();
    state.sendSound = await api.getSendSound();
    state.prefs = await api.getUiPrefs();
    applyMotion(); applyCompact(); void voiceCall(() => api.voiceState());
    void api.getAccent().then(applyAccent).catch(() => undefined);
    void api.getFont().then(applyFont).catch(() => undefined);
    state.showTps = await api.getShowTps();
    state.groupsCollapsed = await api.getDockGroupsCollapsed();
    for (const a of await api.pendingSearches()) state.searchAsks.set(a.id, { chatId: a.chatId, query: a.query });
    state.phone = await api.getPhoneLink();
    await loadBots();
    await loadRooms();
    void api.getAlwaysOnTop().then(renderAlwaysOnTop).catch(() => undefined);
    void maybeShowTips();
    const first = activeBots().find((b) => b.id === pendingOpenBot) ?? activeBots()[0];
    if (first) await selectBot(first.id);
    else applyView();
  } finally {
    initDone = true;
    if (pendingOpenBot !== null && pendingOpenBot !== state.botId && state.bots.some((b) => b.id === pendingOpenBot)) void selectBot(pendingOpenBot);
    pendingOpenBot = null;
  }
}

async function init(): Promise<void> {
  try {
    state.lock = await api.getLockState();
    if (state.lock.locked) showLockScreen(); // nothing else loads until the passphrase is right
    else { hideLockScreen(); await loadAppData(); }
  } finally {
    window.setTimeout(hideSplash, splashRemainingMs(performance.now() - splashStart));
  }
}

void init();

// ---------- v1.20 wiring ----------
el.quoteClear.addEventListener('click', () => { state.quote = null; renderQuoteUi(); });
el.imageClear.addEventListener('click', () => {
  if (state.pendingImage?.relPath.startsWith('pasted:') && state.chat) void api.discardPastedImage(state.chat.id).catch(() => undefined);
  state.pendingImage = null;
  renderQuoteUi();
});

function buildStarterJobs(): void {
  el.starterJobs.replaceChildren(...STARTER_JOBS.map((j) => {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'starter-job secondary'; btn.dataset.job = j.id;
    const img = document.createElement('img');
    img.src = j.icon; img.alt = ''; img.width = 20; img.height = 20;
    btn.append(img, node('span', '', j.label));
    btn.addEventListener('click', () => {
      // Local presets only: fill the form; nothing is sent anywhere.
      el.botName.value = j.name;
      el.botJob.value = j.job;
      for (const b of el.starterJobs.querySelectorAll('button')) b.classList.toggle('active', b === btn);
      el.botName.focus();
    });
    return btn;
  }));
}
buildStarterJobs();

el.shortcutList.replaceChildren(...SHORTCUTS.flatMap((k) => [node('dt', '', k.keys), node('dd', '', k.action)]));

function renderUpdate(u: UpdateState | null): void {
  state.update = u;
  if (!u) return;
  el.updateLast.textContent = u.lastCheck ? new Date(u.lastCheck).toLocaleString() : 'never';
  let status = '';
  if (!u.online) status = 'Online is off, so Cipher Bot does not check for updates.';
  else if (u.checking) status = 'Checking GitHub for a newer version…';
  else if (u.downloading) status = `Downloading… ${u.available ? Math.round((u.done / u.available.size) * 100) : 0}%`;
  else if (u.savedTo) status = `Saved to ${u.savedTo.split(/[\\/]/).pop()} in your Downloads folder. Cipher Bot does not install it.`;
  else if (u.error) status = u.error;
  else if (u.available) status = `Cipher Bot ${u.available.version} is available (${(u.available.size / 1048576).toFixed(1)} MB${u.available.verified ? ', checksum listed by GitHub' : ''}).`;
  else if (u.lastCheck) status = 'Cipher Bot is up to date.';
  el.updateStatus.textContent = status;
  el.updateDownload.hidden = !(u.available && u.online && !u.downloading && !u.savedTo);
  el.updateShow.hidden = !u.savedTo;
}
api.onUpdate(renderUpdate);
el.updateDownload.addEventListener('click', () => void api.downloadUpdate().then(renderUpdate).catch((err) => { el.updateStatus.textContent = plainError(err); }));
el.updateShow.addEventListener('click', () => void api.showUpdateFile());
el.openSettings.addEventListener('click', () => void api.getUpdate().then(renderUpdate).catch(() => undefined));

el.debugExport.addEventListener('click', async () => {
  el.debugMsg.hidden = true;
  try {
    const r = await api.exportDebugLog(el.debugChats.checked);
    if (r.ok) { el.debugMsg.textContent = `Saved ${r.path.split(/[\\/]/).pop()}.`; el.debugMsg.hidden = false; }
    else if (r.error) { el.debugMsg.textContent = r.error; el.debugMsg.hidden = false; }
  } catch (err) { el.debugMsg.textContent = plainError(err); el.debugMsg.hidden = false; }
});

// ---------- v1.21 wiring ----------
el.imageViewerClose.addEventListener('click', closeImageViewer);
el.imageViewer.addEventListener('click', (e) => { if (e.target === el.imageViewer) closeImageViewer(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !el.imageViewer.hidden) { e.preventDefault(); closeImageViewer(); }
  else if (e.key === 'Escape' && !el.tips.hidden) { e.preventDefault(); finishTips(); }
});
el.siteForm.addEventListener('submit', (e) => {
  e.preventDefault();
  el.siteError.hidden = true;
  void api.addBlockedSite(el.siteInput.value).then((list) => { el.siteInput.value = ''; renderSites(list); })
    .catch((err) => { el.siteError.textContent = plainError(err); el.siteError.hidden = false; });
});
el.openSettings.addEventListener('click', () => { void api.blockedSites().then(renderSites).catch(() => undefined); renderArchived(); });
el.alwaysOnTop.addEventListener('click', () => void api.setAlwaysOnTop(!el.alwaysOnTop.classList.contains('on')).then(renderAlwaysOnTop).catch(() => undefined));
api.onAlwaysOnTop(renderAlwaysOnTop);
el.tipNext.addEventListener('click', () => { if (tipIndex >= TIPS.length - 1) finishTips(); else showTip(tipIndex + 1); });
el.tipSkip.addEventListener('click', finishTips);

// ---------- v1.22: save to memory, accent, reduce motion, find in chat, checklist ----------
function showNotice(text: string): void {
  showAttachError(text);
  el.attachError.classList.add('ok');
  window.setTimeout(() => { el.attachError.classList.remove('ok'); clearAttachError(); }, 3000);
}

async function rememberMessage(chatId: number, messageId: number): Promise<void> {
  try {
    const bot = await api.rememberMessage(chatId, messageId);
    state.bots = state.bots.map((b) => (b.id === bot.id ? bot : b));
    showNotice(`Saved to ${bot.name}'s memory note (${bot.memoryNote.length} of 2000 characters).`);
  } catch (err) {
    const msg = plainError(err);
    showAttachError(msg);
    window.setTimeout(() => { if (el.attachError.textContent === msg) clearAttachError(); }, 6000);
  }
}

const ACCENT_NAMES = ['blue', 'teal', 'violet', 'amber', 'rose'] as const;
function applyAccent(a: string): void {
  const name = (ACCENT_NAMES as readonly string[]).includes(a) ? a : 'blue';
  document.documentElement.dataset.accent = name;
  for (const b of el.accentList.querySelectorAll<HTMLButtonElement>('.accent-swatch')) {
    const on = b.dataset.accent === name;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  }
}
el.accentList.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.accent-swatch');
  if (b?.dataset.accent) void api.setAccent(b.dataset.accent as never).then(applyAccent).catch(() => undefined);
});

function applyMotion(): void {
  document.documentElement.classList.toggle('reduce-motion', state.prefs.reduceMotion === true);
  el.motionSwitch.checked = state.prefs.reduceMotion === true;
}
el.motionSwitch.addEventListener('change', () => void setUiPref('reduceMotion', el.motionSwitch.checked));

/** Find in chat: highlights are <mark> elements built with createElement/textContent only (no HTML parsing). */
let findIndex = 0;
function clearFindMarks(): void {
  const parents = new Set<Node>();
  for (const m of el.messages.querySelectorAll('mark.find-hit')) {
    const parent = m.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(m.textContent ?? ''), m);
    parents.add(parent);
  }
  for (const p of parents) p.normalize();
}
function applyFind(scroll: boolean): void {
  clearFindMarks();
  const q = el.findInput.value;
  const hits: HTMLElement[] = [];
  if (q.trim()) {
    for (const box of el.messages.querySelectorAll('.msg-text')) {
      const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
      for (const t of nodes) {
        const text = t.data;
        const ranges = findRanges(text, q);
        if (!ranges.length) continue;
        const frag = document.createDocumentFragment();
        let at = 0;
        for (const [a, b] of ranges) {
          if (a > at) frag.append(document.createTextNode(text.slice(at, a)));
          const mark = document.createElement('mark');
          mark.className = 'find-hit';
          mark.textContent = text.slice(a, b);
          frag.append(mark);
          hits.push(mark);
          at = b;
        }
        if (at < text.length) frag.append(document.createTextNode(text.slice(at)));
        t.replaceWith(frag);
      }
    }
  }
  if (findIndex >= hits.length) findIndex = 0;
  hits.forEach((h, i) => h.classList.toggle('current', i === findIndex));
  el.findCount.textContent = q.trim() ? (hits.length ? `${findIndex + 1} of ${hits.length}` : 'No matches') : '';
  if (scroll && hits[findIndex]) hits[findIndex].scrollIntoView({ block: 'center' });
}
function openFind(): void {
  if (el.chatView.hidden) return;
  el.findBar.hidden = false;
  el.findInput.focus();
  el.findInput.select();
  applyFind(true);
}
function closeFind(): void {
  el.findBar.hidden = true;
  el.findInput.value = '';
  findIndex = 0;
  clearFindMarks();
  el.findCount.textContent = '';
}
function stepFind(d: number): void {
  const n = el.messages.querySelectorAll('mark.find-hit').length;
  if (!n) return;
  findIndex = (findIndex + d + n) % n;
  applyFind(true);
}
el.findInput.addEventListener('input', () => { findIndex = 0; applyFind(true); });
el.findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(); el.input.focus(); }
});
el.findPrev.addEventListener('click', () => stepFind(-1));
el.findNext.addEventListener('click', () => stepFind(1));
el.findClose.addEventListener('click', closeFind);
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f' && !el.chatView.hidden) { e.preventDefault(); openFind(); }
});

/** Checklist for the open bot (user add/check/delete; the bot only adds after main's native confirm). */
let checklistBot: number | null = null;
function renderChecklist(items: ChecklistItem[]): void {
  el.checklistEmpty.hidden = items.length > 0;
  el.checklistList.replaceChildren(...items.map((it) => {
    const li = node('li', `row checklist-item${it.done ? ' done' : ''}`);
    const label = document.createElement('label');
    label.className = 'row checklist-label';
    const box = document.createElement('input');
    box.type = 'checkbox'; box.checked = it.done;
    box.addEventListener('change', () => void checklistCall(() => api.checklistSetDone(it.botId, it.id, box.checked)));
    label.append(box, node('span', 'checklist-text', it.text));
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'secondary small'; del.textContent = 'Delete';
    del.setAttribute('aria-label', `Delete ${it.text}`);
    del.addEventListener('click', () => void checklistCall(() => api.checklistDelete(it.botId, it.id)));
    li.append(label, del);
    return li;
  }));
}
async function checklistCall(fn: () => Promise<ChecklistItem[]>): Promise<void> {
  el.checklistError.hidden = true;
  try { renderChecklist(await fn()); } catch (err) { el.checklistError.textContent = plainError(err); el.checklistError.hidden = false; }
}
async function openChecklist(): Promise<void> {
  const bot = currentBot();
  if (!bot || state.roomId !== null) return;
  checklistBot = bot.id;
  el.checklistName.textContent = `${bot.name}'s checklist`;
  el.checklistModal.hidden = false;
  await checklistCall(() => api.checklist(bot.id));
  el.checklistInput.focus();
}
function closeChecklist(): void { el.checklistModal.hidden = true; checklistBot = null; }
el.checklistForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const id = checklistBot;
  if (id === null || !el.checklistInput.value.trim()) return;
  void checklistCall(() => api.checklistAdd(id, el.checklistInput.value)).then(() => { el.checklistInput.value = ''; });
});
el.checklistClose.addEventListener('click', closeChecklist);
el.checklistModal.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeChecklist(); } });
api.onChecklist((botId) => {
  if (checklistBot === botId) void checklistCall(() => api.checklist(botId));
  const bot = state.bots.find((b) => b.id === botId);
  if (bot) showNotice(`Added an item to ${bot.name}'s checklist.`);
});


// ---------- v1.23: undo the last delete for 10 seconds ----------
let undoState: { id: string; timer: ReturnType<typeof setTimeout> } | null = null;
function hideUndo(): void {
  if (undoState) clearTimeout(undoState.timer);
  undoState = null;
  el.undoToast.hidden = true;
}
function showUndo(id: string, text: string): void {
  hideUndo();
  el.undoText.textContent = `${text} Undo is available for 10 seconds.`;
  el.undoToast.hidden = false;
  undoState = { id, timer: setTimeout(hideUndo, 10_000) };
}
el.undoBtn.addEventListener('click', () => {
  const u = undoState;
  if (!u) return;
  hideUndo();
  void (async () => {
    try {
      await api.undoDelete(u.id);
      await loadBots();
      await loadRooms();
      if (state.roomId !== null && currentRoom()) await selectRoom(state.roomId);
      else if (state.botId !== null && botById(state.botId)) await selectBot(state.botId);
      else if (activeBots().length) await selectBot(activeBots()[0].id);
      else { renderRail(); applyView(); }
    } catch (err) {
      showNotice(plainError(err));
    }
  })();
});

// ---------- v1.23: paste a screenshot (clipboard image bytes go to main and are checked there) ----------
el.input.addEventListener('paste', (e: ClipboardEvent) => {
  const items = e.clipboardData ? [...e.clipboardData.items] : [];
  const item = items.find((i) => i.kind === 'file' && i.type.startsWith('image/'));
  if (!item) return; // plain text pastes as usual
  e.preventDefault();
  const chat = state.chat;
  const file = item.getAsFile();
  if (!chat || state.roomId !== null || !file) { showAttachError('Images can be pasted into a Cipher bot chat.'); return; }
  void (async () => {
    try {
      const r = await api.pasteImage(chat.id, new Uint8Array(await file.arrayBuffer()));
      if (!r.ok) { showAttachError(r.error); return; }
      if (state.chat?.id !== chat.id) return;
      state.pendingImage = { relPath: r.relPath, dataUrl: r.dataUrl };
      renderQuoteUi();
    } catch (err) {
      showAttachError(plainError(err));
    }
  })();
});

// ---------- v1.23: per-bot tool switches (changed only here; main stores and enforces them) ----------
let toolsBot: number | null = null;
function renderTools(bot: Bot): void {
  const t: ToolSwitches = bot.tools ?? { files: bot.toolsEnabled, search: false, calculator: false, checklist: false, write: false };
  for (const box of el.toolsList.querySelectorAll<HTMLInputElement>('input[data-tool]')) {
    const k = box.dataset.tool as keyof ToolSwitches;
    box.checked = t[k];
  }
}
function openTools(): void {
  const bot = currentBot();
  if (!bot || state.roomId !== null) return;
  toolsBot = bot.id;
  el.toolsName.textContent = `${bot.name}'s tools`;
  el.toolsError.hidden = true;
  renderTools(bot);
  el.toolsModal.hidden = false;
  el.toolsList.querySelector<HTMLInputElement>('input')?.focus();
}
function closeTools(): void { el.toolsModal.hidden = true; toolsBot = null; }
el.toolsList.addEventListener('change', (e) => {
  const box = e.target as HTMLInputElement;
  const id = toolsBot;
  if (id === null || !box.dataset.tool) return;
  void (async () => {
    try {
      const bot = await api.setToolSwitches(id, { [box.dataset.tool as keyof ToolSwitches]: box.checked });
      await replaceBot(bot);
      if (toolsBot === id) renderTools(bot);
      el.toolsError.hidden = true;
    } catch (err) {
      el.toolsError.textContent = plainError(err);
      el.toolsError.hidden = false;
    }
  })();
});
el.toolsClose.addEventListener('click', closeTools);
el.toolsModal.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeTools(); } });

// ---------- v1.23: one-time local reminders ----------
let reminderBot: number | null = null;
const STATUS_TEXT: Record<Reminder['status'], string> = { pending: 'Scheduled', done: 'Sent', failed: 'Failed', missed: 'Missed (skipped)', skipped: 'Skipped' };
function renderReminders(list: Reminder[]): void {
  el.reminderEmpty.hidden = list.length > 0;
  el.reminderList.replaceChildren(...list.map((r) => {
    const li = document.createElement('li');
    li.className = `checklist-item reminder-${r.status}`;
    const text = document.createElement('span');
    text.className = 'checklist-text';
    text.textContent = `${formatReminderAt(r.at)} · ${STATUS_TEXT[r.status]}: ${r.prompt}`;
    if (r.note) text.title = r.note;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'secondary small';
    del.textContent = r.status === 'pending' ? 'Cancel' : 'Remove';
    del.addEventListener('click', () => { const id = reminderBot; if (id !== null) void reminderCall(() => api.deleteReminder(id, r.id)); });
    li.append(text, del);
    return li;
  }));
}
async function reminderCall(fn: () => Promise<Reminder[]>): Promise<boolean> {
  try {
    renderReminders(await fn());
    el.reminderError.hidden = true;
    return true;
  } catch (err) {
    el.reminderError.textContent = plainError(err);
    el.reminderError.hidden = false;
    return false;
  }
}
async function openReminders(): Promise<void> {
  const bot = currentBot();
  if (!bot || state.roomId !== null) return;
  reminderBot = bot.id;
  el.reminderName.textContent = `Reminders for ${bot.name}`;
  const soon = new Date(Date.now() + 60 * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  el.reminderDate.value = `${soon.getFullYear()}-${pad(soon.getMonth() + 1)}-${pad(soon.getDate())}`;
  el.reminderTime.value = `${pad(soon.getHours())}:00`;
  el.reminderModal.hidden = false;
  await reminderCall(() => api.reminders(bot.id));
  el.reminderPrompt.focus();
}
function closeReminders(): void { el.reminderModal.hidden = true; reminderBot = null; }
el.reminderForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const id = reminderBot;
  if (id === null) return;
  const at = `${el.reminderDate.value}T${el.reminderTime.value}`;
  void reminderCall(() => api.addReminder(id, at, el.reminderPrompt.value)).then((ok) => { if (ok) el.reminderPrompt.value = ''; });
});
el.reminderClose.addEventListener('click', closeReminders);
el.reminderModal.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeReminders(); } });
api.onReminders((botId) => { if (reminderBot === botId) void reminderCall(() => api.reminders(botId)); });

// ---------- v1.23: focus mode (dock, search bar and frames hidden; Esc exits) ----------
function setFocusMode(on: boolean): void {
  document.documentElement.classList.toggle('focus-mode', on);
  el.focusToggle.setAttribute('aria-pressed', String(on));
  el.focusToggle.title = on ? 'Exit focus mode (Esc)' : 'Focus mode (Esc exits)';
}
const inFocusMode = (): boolean => document.documentElement.classList.contains('focus-mode');
el.focusToggle.addEventListener('click', () => setFocusMode(!inFocusMode()));
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f' && !el.chatView.hidden) { e.preventDefault(); setFocusMode(!inFocusMode()); return; }
  // Esc exits focus mode, unless a dialog or the find bar is using Esc (they stop it first).
  if (e.key === 'Escape' && inFocusMode() && !e.defaultPrevented) setFocusMode(false);
});

// ---------- v1.23: Settings → Storage ----------
function renderDisk(d: DiskUsage): void {
  const row = (k: string, v: string) => { const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = v; return [dt, dd]; };
  el.diskList.replaceChildren(
    ...row('Chats (cipher.db)', formatSize(d.chats)),
    ...row('Files (attached folders)', d.folders === 0 ? 'No folders attached'
      : `${formatSize(d.files ?? 0)}${d.filesCapped ? '+ (stopped counting: very large folder)' : ''} in ${d.folders} folder${d.folders === 1 ? '' : 's'}`),
    ...row('Backups', d.backups === null ? 'Unknown' : formatSize(d.backups)),
  );
  const note = document.createElement('dd');
  note.className = 'muted';
  note.textContent = d.backupsNote;
  el.diskList.append(note);
}
async function refreshDisk(): Promise<void> {
  try { renderDisk(await api.diskUsage()); } catch (err) { el.diskList.replaceChildren(document.createTextNode(plainError(err))); }
}
el.diskRefresh.addEventListener('click', () => void refreshDisk());

// ---------- v1.24 ----------
function renderTagFilter(): void {
  const tags = allTags(activeBots());
  if (state.tagFilter && !tags.some((t) => t.toLowerCase() === state.tagFilter.toLowerCase())) state.tagFilter = '';
  const opts = [new Option('All', ''), ...tags.map((t) => new Option(t, t))];
  el.tagFilter.replaceChildren(...opts);
  el.tagFilter.value = state.tagFilter;
  (el.tagFilter.parentElement as HTMLElement).hidden = tags.length === 0;
}
el.tagFilter.addEventListener('change', () => { state.tagFilter = el.tagFilter.value; renderRail(); });

async function toggleGroup(group: string): Promise<void> {
  const next = state.groupsCollapsed.includes(group) ? state.groupsCollapsed.filter((g) => g !== group) : [...state.groupsCollapsed, group];
  state.groupsCollapsed = next;
  renderRail();
  try { state.groupsCollapsed = await api.setDockGroupsCollapsed(next); } catch { /* kept locally until next load */ }
}

function fillGroupList(): void {
  const groups = [...new Set(state.bots.map((b) => b.group).filter((g): g is string => !!g))].sort();
  el.botGroupList.replaceChildren(...groups.map((g) => new Option(g, g)));
}

async function saveTagsAndGroup(bot: Bot): Promise<Bot> {
  const tags = el.botTags.value.split(',').map((t) => t.trim()).filter(Boolean);
  let b = bot;
  if (tags.join('|') !== (b.tags ?? []).join('|')) b = await api.setBotTags(b.id, tags);
  if (el.botGroup.value.trim() !== (b.group ?? '')) b = await api.setBotGroup(b.id, el.botGroup.value);
  return b;
}

// Auto-title: the name follows the job until the user types a name (always editable).
el.botName.addEventListener('input', () => { state.nameTouched = el.botName.value.trim().length > 0; });
el.botJob.addEventListener('input', () => {
  if (state.editBotId !== null || state.nameTouched) return;
  el.botName.value = autoTitle(el.botJob.value);
});

async function refreshActivity(): Promise<void> {
  const id = state.botId;
  if (id === null) return;
  try {
    const a = await api.botActivity(id);
    if (state.botId !== id) return;
    state.activity = formatActivity(a);
    el.chatActivity.textContent = state.roomId === null ? state.activity : '';
  } catch { /* the line just stays empty */ }
}

function startEdit(row: HTMLElement, m: Message, chatId: number): void {
  const textEl = row.querySelector('.msg-text');
  if (!textEl || row.querySelector('.edit-area')) return;
  const ta = document.createElement('textarea');
  ta.className = 'edit-area'; ta.value = m.content; ta.rows = 3; ta.setAttribute('aria-label', 'Edit message');
  const save = document.createElement('button'); save.type = 'button'; save.textContent = 'Save';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'secondary'; cancel.textContent = 'Cancel';
  const bar = node('div', 'row end'); bar.append(cancel, save);
  textEl.replaceWith(ta);
  row.append(bar);
  ta.focus();
  cancel.addEventListener('click', () => renderChat());
  save.addEventListener('click', () => {
    void api.editMessage(chatId, m.id, ta.value).then((upd) => {
      const i = state.messages.findIndex((x) => x.id === m.id);
      if (i >= 0) state.messages[i] = upd;
      renderChat();
    }).catch((err) => { state.error = plainError(err); renderChat(); });
  });
}

async function openEdits(chatId: number, id: number): Promise<void> {
  let edits: MessageEdit[] = [];
  try { edits = await api.listMessageEdits(chatId, id); } catch (err) { state.error = plainError(err); renderChat(); return; }
  el.editsList.replaceChildren(...edits.map((e) => {
    const li = document.createElement('li');
    li.append(node('span', 'muted', `${formatMessageTime(e.editedAt)} · before: `), document.createTextNode(e.oldText));
    return li;
  }));
  if (!edits.length) el.editsList.replaceChildren(node('li', 'muted', 'No older text.'));
  el.editsModal.hidden = false;
  el.editsClose.focus();
}
el.editsClose.addEventListener('click', () => { el.editsModal.hidden = true; });
el.editsModal.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); el.editsModal.hidden = true; } });

async function summarizeFolder(): Promise<void> {
  const chat = state.chat;
  if (!chat || state.roomId !== null) return;
  try { await api.summarizeFolder(chat.id); } catch (err) { state.error = plainError(err); renderChat(); }
}

el.reminderImportForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const id = reminderBot;
  if (id === null) return;
  void reminderCall(() => api.importReminder(id, el.reminderLine.value)).then((ok) => { if (ok) el.reminderLine.value = ''; });
});

// Settings: lock timeout, tokens/s, font, scheduled backup, shared folder, settings file.
function applyFont(f: string): void {
  if (f === 'system') delete document.documentElement.dataset.font;
  else document.documentElement.dataset.font = f;
  el.fontSelect.value = f;
}
function renderBackupSched(b: BackupScheduleState): void {
  el.backupSchedule.value = b.schedule;
  el.backupSchedMsg.textContent = `${b.folder ? `Folder: ${b.folder}` : 'No folder chosen.'}${b.last ? ` · Last backup ${new Date(b.last).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : ''}`;
}
const sharedText = (f: string | null): string => f ?? 'None';
async function refreshV124Settings(): Promise<void> {
  try {
    el.lockTimeout.value = await api.getLockTimeout();
    el.tpsSwitch.checked = state.showTps = await api.getShowTps();
    applyFont(await api.getFont());
    renderBackupSched(await api.getBackupSchedule());
    const sf = await api.getSharedFolder();
    el.sharedFolderPath.textContent = sharedText(sf);
    el.sharedFolderClear.disabled = !sf;
  } catch { /* locked or closing */ }
  for (const p of [el.backupSchedError, el.settingsFileMsg, el.settingsFileError]) p.hidden = true;
}
el.lockTimeout.addEventListener('change', () => void api.setLockTimeout(el.lockTimeout.value as '1' | '5' | '15' | 'never'));
el.tpsSwitch.addEventListener('change', () => void api.setShowTps(el.tpsSwitch.checked).then((on) => { state.showTps = on; }));
el.fontSelect.addEventListener('change', () => void api.setFont(el.fontSelect.value as 'system' | 'sans' | 'serif' | 'mono').then(applyFont));
const backupSchedCall = (f: () => Promise<BackupScheduleState>): void => {
  el.backupSchedError.hidden = true;
  void f().then(renderBackupSched).catch((err) => {
    el.backupSchedError.textContent = plainError(err); el.backupSchedError.hidden = false;
    void api.getBackupSchedule().then(renderBackupSched).catch(() => undefined);
  });
};
el.backupSchedule.addEventListener('change', () => backupSchedCall(() => api.setBackupSchedule(el.backupSchedule.value as 'off' | 'daily' | 'weekly')));
el.backupFolderBtn.addEventListener('click', () => backupSchedCall(() => api.pickBackupFolder()));
el.sharedFolderPick.addEventListener('click', () => void api.pickSharedFolder().then((f) => { el.sharedFolderPath.textContent = sharedText(f); el.sharedFolderClear.disabled = !f; }));
el.sharedFolderClear.addEventListener('click', () => void api.clearSharedFolder().then(() => { el.sharedFolderPath.textContent = 'None'; el.sharedFolderClear.disabled = true; }));
const settingsFileResult = (msg: string | null, err?: unknown): void => {
  el.settingsFileMsg.hidden = !msg; el.settingsFileMsg.textContent = msg ?? '';
  el.settingsFileError.hidden = err === undefined; el.settingsFileError.textContent = err === undefined ? '' : plainError(err);
};
el.settingsExport.addEventListener('click', () => void api.exportSettings(el.settingsMemory.checked)
  .then((r) => settingsFileResult(r.ok ? `Saved to ${r.path}` : null)).catch((e) => settingsFileResult(null, e)));
el.settingsImport.addEventListener('click', () => void api.importSettings(el.settingsMemory.checked)
  .then(async (r) => {
    if (!r.ok) return settingsFileResult(null);
    settingsFileResult(`Imported ${r.applied} setting${r.applied === 1 ? '' : 's'}${r.memory ? ` and ${r.memory} memory note${r.memory === 1 ? '' : 's'}` : ''}.`);
    state.prefs = await api.getUiPrefs(); state.sendSound = await api.getSendSound();
    applyMotion(); void api.getAccent().then(applyAccent);
    await refreshV124Settings(); await loadBots(); renderSettings();
  }).catch((e) => settingsFileResult(null, e)));
