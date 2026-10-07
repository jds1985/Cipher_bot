import type { Bot, Chat, ChatEvent, CipherApi, Message, PhoneLinkStatus, Room, RoomEvent, RoomMessage, SetupState } from '../shared/types';
import { decideView, roomTitle, setupCopy } from './view.js';
import { BOT_COLORS, BOT_SHAPES, COLOR_LABELS, DEFAULT_COLOR, SHAPE_LABELS, colorClass, colorOf, leastUsedShape, shapeOf, shapeSvg } from './botIcon.js';

declare global {
  interface Window { cipher: CipherApi }
}

const api = window.cipher;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const el = {
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
  chatIcon: $('chat-icon'), chatBotName: $('chat-bot-name'), chatTitle: $('chat-title'), roomNote: $('room-note'),
  botSettings: $('bot-settings'), chatTools: $<HTMLInputElement>('chat-tools'),
  chatFolderLabel: $('chat-folder-label'), chatFolderPick: $<HTMLButtonElement>('chat-folder-pick'),
  botDelete: $<HTMLButtonElement>('bot-delete'), botEdit: $<HTMLButtonElement>('bot-edit'),
  chatExport: $<HTMLButtonElement>('chat-export'), chatClear: $<HTMLButtonElement>('chat-clear'),
  messages: $('messages'), composer: $<HTMLFormElement>('composer'), input: $<HTMLTextAreaElement>('input'),
  attach: $<HTMLButtonElement>('attach'), attachChip: $('attach-chip'), attachChipName: $('attach-chip-name'),
  attachClear: $<HTMLButtonElement>('attach-clear'), attachError: $('attach-error'),
  send: $<HTMLButtonElement>('send'), stop: $<HTMLButtonElement>('stop'),
  settingsView: $('settings-view'), openSettings: $<HTMLButtonElement>('open-settings'),
  settingsClose: $<HTMLButtonElement>('settings-close'),
  onlineSwitch: $<HTMLInputElement>('online-switch'),
  phoneStart: $<HTMLButtonElement>('phone-start'), phoneStop: $<HTMLButtonElement>('phone-stop'),
  phoneRefresh: $<HTMLButtonElement>('phone-refresh'), phoneStatus: $('phone-status'),
  phoneCode: $('phone-code'), phoneExpiry: $('phone-expiry'), phoneUrls: $('phone-urls'),
  phoneQrWrap: $('phone-qr-wrap'), phoneQr: $<HTMLImageElement>('phone-qr'), phonePrimaryUrl: $('phone-primary-url'),
  confirmModal: $('confirm-modal'), confirmTitle: $('confirm-title'), confirmBody: $('confirm-body'),
  confirmCancel: $<HTMLButtonElement>('confirm-cancel'), confirmOk: $<HTMLButtonElement>('confirm-ok'),
};

const CHAT_PLACEHOLDER = el.input.placeholder;
const ROOM_PLACEHOLDER = 'Message the room (each Cipher bot replies once; type @Name to ask just one)';

const state = {
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
  /** Bot ids currently streaming a reply (working-dot). */
  speakingBots: new Set<number>(),
  online: false,
  phone: { running: false, port: 17865, pairingCode: null, pairingExpiresAt: null, urls: [], sessionCount: 0, primaryUrl: null, qrDataUrl: null } as PhoneLinkStatus,
  setup: { phase: 'checking', percent: null, completed: 0, total: 0, message: null } as SetupState,
  /** Client-side filter for bot/room names and open-chat messages. */
  searchQuery: '',
  /** Desktop-only pending attach block for the next 1:1 send (rooms skipped). */
  pendingAttach: null as { relPath: string; block: string } | null,
};

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
    botCount: state.bots.length, formOpen: state.formOpen, roomFormOpen: state.roomFormOpen,
    settingsOpen: state.settingsOpen, setup: state.setup,
  });
  // The edit modal reuses the create form, shown over the chat.
  const editing = state.editBotId !== null && view === 'chat';
  el.formView.hidden = view !== 'form' && !editing;
  el.formView.classList.toggle('edit-modal', editing);
  el.roomFormView.hidden = view !== 'room-form';
  el.settingsView.hidden = view !== 'settings';
  el.setupView.hidden = view !== 'setup';
  el.chatView.hidden = view !== 'chat';
  el.botCancel.hidden = state.bots.length === 0 && !editing; // nothing to go back to on first run
  if (view === 'setup') renderSetup();
  if (view === 'chat') renderChat();
  if (view === 'settings') renderSettings();
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

function nameMatches(hay: string, q: string): boolean {
  if (!q) return true;
  return hay.toLowerCase().includes(q);
}

function renderRail(): void {
  const showingChat = !state.formOpen && !state.roomFormOpen && !state.settingsOpen;
  const q = state.searchQuery.trim().toLowerCase();
  el.botList.replaceChildren(...state.bots.map((b) => {
    const working = state.speakingBots.has(b.id);
    const btn = railButton(`bot${working ? ' working' : ''}`, b.toolsEnabled ? `${b.name} (reads files)` : b.name, showingChat && b.id === state.botId, () => void selectBot(b.id));
    btn.append(botIcon(b, 42));
    if (!nameMatches(b.name, q)) btn.classList.add('filtered-out');
    return btn;
  }));
  el.roomList.replaceChildren(...state.rooms.map((r) => {
    const label = `Room: ${roomName(r)}`;
    const btn = railButton('room', label, showingChat && r.id === state.roomId, () => void selectRoom(r.id));
    btn.append(roomMark(r));
    if (!nameMatches(roomName(r), q) && !nameMatches(r.name, q)) btn.classList.add('filtered-out');
    return btn;
  }));
  el.openSettings.classList.toggle('active', state.settingsOpen);
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
  state.formOpen = false;
  state.editBotId = null;
  state.roomFormOpen = false;
  state.settingsOpen = false;
  state.roomId = null;
  state.pendingAttach = null;
  clearAttachError();
  state.botId = botId;
  state.chat = await api.openBotChat(botId);
  state.messages = await api.listMessages(state.chat.id);
  state.live = '';
  state.error = null;
  renderRail();
  applyView(); // renders the chat once it's visible, so scrolling to the latest message works
  if (!el.chatView.hidden) el.input.focus();
}

async function selectRoom(roomId: number): Promise<void> {
  state.formOpen = false;
  state.editBotId = null;
  state.roomFormOpen = false;
  state.settingsOpen = false;
  state.botId = null;
  state.chat = null;
  state.pendingAttach = null;
  clearAttachError();
  state.roomId = roomId;
  state.roomMessages = await api.listRoomMessages(roomId);
  state.error = null;
  renderRail();
  applyView();
  if (!el.chatView.hidden) el.input.focus();
}

// ---------- chat view (a bot's chat or a room) ----------
function toolCallLabel(m: Message): string {
  return (m.toolCalls ?? []).map((c) => {
    const p = (c.function?.arguments as { path?: unknown })?.path;
    return typeof p === 'string' ? p : '';
  }).join(', ');
}

// ---------- copy a message ----------
const SVG_NS = 'http://www.w3.org/2000/svg';
/** The small copy icon (two overlapping rounded squares), built with DOM calls (no inline styles). */
function copyIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const [x, y] of [[8, 8], [4, 4]]) {
    const r = document.createElementNS(SVG_NS, 'rect');
    r.setAttribute('x', String(x)); r.setAttribute('y', String(y));
    r.setAttribute('width', '12'); r.setAttribute('height', '12'); r.setAttribute('rx', '2.5');
    r.setAttribute('fill', 'none'); r.setAttribute('stroke', 'currentColor'); r.setAttribute('stroke-width', '2');
    svg.append(r);
  }
  return svg;
}

function copyButton(text: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'copy-btn';
  btn.title = 'Copy message';
  btn.setAttribute('aria-label', 'Copy message');
  btn.append(copyIcon());
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      await api.copyText(text);
      btn.classList.add('copied');
      btn.title = 'Copied';
      btn.setAttribute('aria-label', 'Copied');
      window.setTimeout(() => {
        btn.classList.remove('copied');
        btn.title = 'Copy message';
        btn.setAttribute('aria-label', 'Copy message');
      }, 1200);
    } catch (err) {
      state.error = plainError(err);
      renderChat();
    }
  });
  return btn;
}

/** A user or bot message bubble: the text plus a small copy button. */
function bubble(cls: string, text: string): HTMLElement {
  const msg = node('div', `msg ${cls}`);
  msg.append(node('span', 'msg-text', text), copyButton(text));
  return msg;
}

function renderChat(): void {
  if (state.roomId !== null) renderRoom();
  else renderBotChat();
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
  el.chatIcon.replaceChildren(botIcon(bot, 40));
  el.chatBotName.textContent = bot.name;
  el.chatTitle.textContent = chat.title;
  el.chatTitle.hidden = false;
  el.roomNote.hidden = true;
  el.botSettings.hidden = false;
  el.chatClear.hidden = false;
  el.chatTools.checked = bot.toolsEnabled;
  el.chatFolderPick.hidden = !bot.toolsEnabled;
  el.chatFolderLabel.hidden = !bot.toolsEnabled;
  el.chatFolderLabel.textContent = bot.folderPath ?? 'No folder chosen';
  el.chatFolderLabel.title = bot.folderPath ?? '';

  const q = state.searchQuery.trim().toLowerCase();
  const items: HTMLElement[] = [];
  for (const m of state.messages) {
    const match = !q || m.content.toLowerCase().includes(q);
    let row: HTMLElement | null = null;
    if (m.role === 'user') row = bubble('user', m.content);
    else if (m.role === 'assistant') {
      if (m.content) row = bubble('assistant', m.content);
      if (m.toolCalls?.length) {
        const note = node('div', 'msg note', `Reading file: ${toolCallLabel(m)}`);
        if (!match) note.classList.add('search-hidden');
        items.push(note);
      }
    } else {
      const bad = m.content.startsWith('Error:');
      row = node('div', `msg note${bad ? ' bad' : ''}`, bad ? `Couldn't read the file: ${m.content.slice(7)}` : `Read ${m.content.length} characters from the file`);
    }
    if (row) {
      if (!match) row.classList.add('search-hidden');
      items.push(row);
    }
  }
  const busy = state.busy.has(chat.id);
  if (busy) items.push(node('div', 'msg assistant live', state.live));
  if (state.error) items.push(node('div', 'msg error', state.error));
  if (!items.length) items.push(node('div', 'msg note', `Say hello to ${bot.name}.`));
  el.messages.replaceChildren(...items);
  el.messages.scrollTop = el.messages.scrollHeight;
  setComposer(busy, CHAT_PLACEHOLDER);
  renderAttachUi(true);
}

/** A room reply: the speaking bot's icon + name, then the text. */
function roomReply(botId: number | null, text: string, live = false): HTMLElement {
  const bot = botById(botId);
  const msg = node('div', `msg assistant room-msg${live ? ' live' : ''}`);
  const speaker = node('div', 'speaker');
  if (bot) speaker.append(botIcon(bot, 26));
  speaker.append(node('span', 'name', bot ? bot.name : 'Cipher bot'));
  msg.append(speaker, node('div', 'text', text));
  if (!live) msg.append(copyButton(text));
  return msg;
}

function renderRoom(): void {
  const room = currentRoom();
  if (!room) return;
  const members = roomMembers(room);
  el.chatIcon.replaceChildren(roomMark(room));
  el.chatBotName.textContent = roomName(room);
  el.chatTitle.textContent = room.name.trim() ? members.map((b) => b.name).join(', ') : `${members.length} Cipher bots`;
  el.roomNote.hidden = false; // "File reading is off in rooms"
  el.botSettings.hidden = true;
  el.chatClear.hidden = true; // Clear chat is for 1:1 chats only

  const q = state.searchQuery.trim().toLowerCase();
  const items: HTMLElement[] = [];
  for (const m of state.roomMessages) {
    const match = !q || m.content.toLowerCase().includes(q);
    const row = m.role === 'user' ? bubble('user', m.content) : roomReply(m.botId, m.content);
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
  const outgoing = attachBlock ? (text ? `${text}\n\n${attachBlock}` : attachBlock) : text;
  if (!outgoing.trim()) return;
  state.error = null;
  state.live = '';
  state.busy.add(chat.id);
  if (state.botId != null) { state.speakingBots.add(state.botId); renderRail(); }
  el.input.value = '';
  const clearedAttach = state.pendingAttach;
  state.pendingAttach = null;
  renderChat();
  try {
    await api.sendMessage(chat.id, outgoing);
  } catch (e) {
    state.busy.delete(chat.id);
    if (state.botId != null) { state.speakingBots.delete(state.botId); renderRail(); }
    state.error = plainError(e);
    el.input.value = text;
    state.pendingAttach = clearedAttach;
    renderChat();
  }
}

function speakingBotForChat(chatId: number): number | null {
  const chat = state.chat?.id === chatId ? state.chat : null;
  if (chat) return chat.botId;
  // When events arrive for another chat, find the bot from known bots' open chat is unknown; use current only.
  return state.botId;
}

async function onChatEvent(ev: ChatEvent): Promise<void> {
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
    case 'token':
      state.live += ev.text;
      updateLive();
      return;
    case 'message':
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
      const updated = await api.updateBot(state.editBotId, form);
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
    const bot = await api.createBot(form);
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
  el.roomMembers.replaceChildren(...state.bots.map((b) => {
    const label = node('label', 'row member-opt') as HTMLLabelElement;
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = String(b.id);
    label.append(box, botIcon(b, 30), node('span', 'name', b.name));
    return label;
  }));
  const tooFew = state.bots.length < 2;
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
  state.editBotId = null;
  state.roomFormOpen = false;
  state.settingsOpen = false;
  renderRail();
  applyView();
}

function openSettings(): void {
  state.settingsOpen = true;
  state.editBotId = null;
  state.formOpen = false;
  state.roomFormOpen = false;
  renderRail();
  applyView();
}

function renderSettings(): void {
  el.onlineSwitch.checked = state.online;
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
  el.attach.hidden = !show;
  el.attach.disabled = !show || (state.chat ? state.busy.has(state.chat.id) : false);
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

async function requestDeleteBot(): Promise<void> {
  const bot = currentBot();
  if (!bot) return;
  const inRooms = state.rooms.filter((r) => r.memberIds.includes(bot.id));
  const roomNote = inRooms.length
    ? ` It will also be removed from ${inRooms.length} room${inRooms.length === 1 ? '' : 's'}; any room left with fewer than 2 Cipher bots will be deleted.`
    : '';
  openConfirm(
    `Delete ${bot.name}?`,
    `This permanently deletes this Cipher bot and its chat history.${roomNote}`,
    async () => {
      const result = await api.deleteBot(bot.id);
      state.pendingAttach = null;
      await loadBots();
      await loadRooms();
      if (state.bots.length) await selectBot(state.bots[0].id);
      else {
        state.botId = null;
        state.chat = null;
        state.messages = [];
        state.formOpen = true;
        renderRail();
        applyView();
      }
      if (result.deletedRoomIds.length) {
        /* rooms already reloaded */
      }
    },
  );
}

// ---------- clear chat (confirm required; 1:1 only) ----------
function requestClearChat(): void {
  const bot = currentBot();
  if (!bot || state.roomId !== null) return;
  openConfirm(
    `Clear chat with ${bot.name}?`,
    'This permanently deletes the messages in this chat. The Cipher bot, its settings and its rooms stay.',
    async () => {
      const chat = await api.clearBotChat(bot.id);
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
el.botCancel.addEventListener('click', () => { if (state.editBotId !== null) closeEditBot(); else closeForms(); });
el.formView.addEventListener('click', (e) => { if (state.editBotId !== null && e.target === el.formView) closeEditBot(); });
el.botEdit.addEventListener('click', openEditBot);
el.chatClear.addEventListener('click', requestClearChat);
el.chatExport.addEventListener('click', () => void exportOpenChat());
el.roomCancel.addEventListener('click', closeForms);
el.onlineSwitch.addEventListener('change', async () => {
  state.online = await api.setOnline(el.onlineSwitch.checked);
  renderSettings();
});
el.phoneStart.addEventListener('click', async () => { state.phone = await api.startPhoneLink(); renderSettings(); });
el.phoneStop.addEventListener('click', async () => { state.phone = await api.stopPhoneLink(); renderSettings(); });
el.phoneRefresh.addEventListener('click', async () => { state.phone = await api.refreshPhoneLinkCode(); renderSettings(); });
api.onPhoneLink(onPhoneStatus);
el.form.addEventListener('submit', (e) => void submitBotForm(e));
el.roomForm.addEventListener('submit', (e) => void submitRoomForm(e));
el.setupGetEngine.addEventListener('click', () => void api.openEngineDownload());
el.setupRetry.addEventListener('click', () => void api.startSetup());
api.onSetupState(onSetupState);
el.chatTools.addEventListener('change', async () => {
  const bot = currentBot();
  if (bot) await replaceBot(await api.setBotTools(bot.id, el.chatTools.checked));
});
el.chatFolderPick.addEventListener('click', async () => {
  const bot = currentBot();
  const folder = bot && (await api.pickFolder());
  if (bot && folder) await replaceBot(await api.setBotFolder(bot.id, folder));
});
el.botDelete.addEventListener('click', () => void requestDeleteBot());
el.attach.addEventListener('click', () => void attachFile());
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

// ---------- window focus ----------
// Bot icon animations pause while the window is in the background (see .unfocused in styles.css).
const setUnfocused = (unfocused: boolean): void => { document.documentElement.classList.toggle('unfocused', unfocused); };
window.addEventListener('focus', () => setUnfocused(false));
window.addEventListener('blur', () => setUnfocused(true));
setUnfocused(!document.hasFocus()); // sync on load

// ---------- splash ----------
// Shows only "Cipher" while the app loads: at least ~0.7 s so it doesn't flicker, at most 1.5 s.
// It never waits on the model or setup (the CSS also hides it after 2 s as a safety net).
const splashStart = performance.now();
let splashDone = false;
function hideSplash(): void {
  if (splashDone) return;
  splashDone = true;
  el.splash.classList.add('hide');
  window.setTimeout(() => el.splash.remove(), 300);
}
window.setTimeout(hideSplash, 1500);

async function init(): Promise<void> {
  try {
    state.setup = await api.getSetup();
    state.online = await api.getOnline();
    state.phone = await api.getPhoneLink();
    await loadBots();
    await loadRooms();
    if (state.bots.length) await selectBot(state.bots[0].id);
    else applyView();
  } finally {
    window.setTimeout(hideSplash, Math.max(0, 700 - (performance.now() - splashStart)));
  }
}

void init();
