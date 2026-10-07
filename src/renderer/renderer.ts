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
  botList: $('bot-list'), roomList: $('room-list'),
  newBot: $<HTMLButtonElement>('new-bot'), newRoom: $<HTMLButtonElement>('new-room'), newRoomMark: $('new-room-mark'),
  formView: $('bot-form-view'), roomFormView: $('room-form-view'), chatView: $('chat-view'), setupView: $('setup-view'),
  form: $<HTMLFormElement>('bot-form'), botName: $<HTMLInputElement>('bot-name'), botJob: $<HTMLTextAreaElement>('bot-job'),
  shapePicker: $('shape-picker'), colorPicker: $('color-picker'),
  botFormError: $('bot-form-error'), botCancel: $<HTMLButtonElement>('bot-cancel'),
  roomForm: $<HTMLFormElement>('room-form'), roomName: $<HTMLInputElement>('room-name'), roomMembers: $('room-members'),
  roomFormError: $('room-form-error'), roomCancel: $<HTMLButtonElement>('room-cancel'), roomCreate: $<HTMLButtonElement>('room-create'),
  setupText: $('setup-text'), setupProgress: $<HTMLProgressElement>('setup-progress'), setupDetail: $('setup-detail'),
  setupGetEngine: $<HTMLButtonElement>('setup-get-engine'), setupRetry: $<HTMLButtonElement>('setup-retry'),
  chatIcon: $('chat-icon'), chatBotName: $('chat-bot-name'), chatTitle: $('chat-title'), roomNote: $('room-note'),
  botSettings: $('bot-settings'), chatTools: $<HTMLInputElement>('chat-tools'),
  chatFolderLabel: $('chat-folder-label'), chatFolderPick: $<HTMLButtonElement>('chat-folder-pick'),
  messages: $('messages'), composer: $<HTMLFormElement>('composer'), input: $<HTMLTextAreaElement>('input'),
  send: $<HTMLButtonElement>('send'), stop: $<HTMLButtonElement>('stop'),
  settingsView: $('settings-view'), openSettings: $<HTMLButtonElement>('open-settings'),
  settingsClose: $<HTMLButtonElement>('settings-close'),
  onlineSwitch: $<HTMLInputElement>('online-switch'),
  phoneStart: $<HTMLButtonElement>('phone-start'), phoneStop: $<HTMLButtonElement>('phone-stop'),
  phoneRefresh: $<HTMLButtonElement>('phone-refresh'), phoneStatus: $('phone-status'),
  phoneCode: $('phone-code'), phoneExpiry: $('phone-expiry'), phoneUrls: $('phone-urls'),
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
  roomFormOpen: false,
  settingsOpen: false,
  /** Bot ids currently streaming a reply (working-dot). */
  speakingBots: new Set<number>(),
  online: false,
  phone: { running: false, port: 17865, pairingCode: null, pairingExpiresAt: null, urls: [], sessionCount: 0 } as PhoneLinkStatus,
  setup: { phase: 'checking', percent: null, completed: 0, total: 0, message: null } as SetupState,
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
  el.formView.hidden = view !== 'form';
  el.roomFormView.hidden = view !== 'room-form';
  el.settingsView.hidden = view !== 'settings';
  el.setupView.hidden = view !== 'setup';
  el.chatView.hidden = view !== 'chat';
  el.botCancel.hidden = state.bots.length === 0; // nothing to go back to on first run
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

function renderRail(): void {
  const showingChat = !state.formOpen && !state.roomFormOpen && !state.settingsOpen;
  el.botList.replaceChildren(...state.bots.map((b) => {
    const working = state.speakingBots.has(b.id);
    const btn = railButton(`bot${working ? ' working' : ''}`, b.toolsEnabled ? `${b.name} (reads files)` : b.name, showingChat && b.id === state.botId, () => void selectBot(b.id));
    btn.append(botIcon(b, 42));
    return btn;
  }));
  el.roomList.replaceChildren(...state.rooms.map((r) => {
    const label = `Room: ${roomName(r)}`;
    const btn = railButton('room', label, showingChat && r.id === state.roomId, () => void selectRoom(r.id));
    btn.append(roomMark(r));
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
  state.roomFormOpen = false;
  state.settingsOpen = false;
  state.roomId = null;
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
  state.roomFormOpen = false;
  state.settingsOpen = false;
  state.botId = null;
  state.chat = null;
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
  el.chatTools.checked = bot.toolsEnabled;
  el.chatFolderPick.hidden = !bot.toolsEnabled;
  el.chatFolderLabel.hidden = !bot.toolsEnabled;
  el.chatFolderLabel.textContent = bot.folderPath ?? 'No folder chosen';
  el.chatFolderLabel.title = bot.folderPath ?? '';

  const items: HTMLElement[] = [];
  for (const m of state.messages) {
    if (m.role === 'user') items.push(node('div', 'msg user', m.content));
    else if (m.role === 'assistant') {
      if (m.content) items.push(node('div', 'msg assistant', m.content));
      if (m.toolCalls?.length) items.push(node('div', 'msg note', `Reading file: ${toolCallLabel(m)}`));
    } else {
      const bad = m.content.startsWith('Error:');
      items.push(node('div', `msg note${bad ? ' bad' : ''}`, bad ? `Couldn't read the file: ${m.content.slice(7)}` : `Read ${m.content.length} characters from the file`));
    }
  }
  const busy = state.busy.has(chat.id);
  if (busy) items.push(node('div', 'msg assistant live', state.live));
  if (state.error) items.push(node('div', 'msg error', state.error));
  if (!items.length) items.push(node('div', 'msg note', `Say hello to ${bot.name}.`));
  el.messages.replaceChildren(...items);
  el.messages.scrollTop = el.messages.scrollHeight;
  setComposer(busy, CHAT_PLACEHOLDER);
}

/** A room reply: the speaking bot's icon + name, then the text. */
function roomReply(botId: number | null, text: string, live = false): HTMLElement {
  const bot = botById(botId);
  const msg = node('div', `msg assistant room-msg${live ? ' live' : ''}`);
  const speaker = node('div', 'speaker');
  if (bot) speaker.append(botIcon(bot, 26));
  speaker.append(node('span', 'name', bot ? bot.name : 'Cipher bot'));
  msg.append(speaker, node('div', 'text', text));
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

  const items: HTMLElement[] = [];
  for (const m of state.roomMessages) {
    if (m.role === 'user') items.push(node('div', 'msg user', m.content));
    else items.push(roomReply(m.botId, m.content));
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
  if (!text) return;
  if (state.roomId !== null) {
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
  state.error = null;
  state.live = '';
  state.busy.add(chat.id);
  if (state.botId != null) { state.speakingBots.add(state.botId); renderRail(); }
  el.input.value = '';
  renderChat();
  try {
    await api.sendMessage(chat.id, text);
  } catch (e) {
    state.busy.delete(chat.id);
    if (state.botId != null) { state.speakingBots.delete(state.botId); renderRail(); }
    state.error = plainError(e);
    el.input.value = text;
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

function openBotForm(): void {
  el.form.reset();
  resetPickers();
  el.botFormError.hidden = true;
  state.formOpen = true;
  state.roomFormOpen = false;
  state.settingsOpen = false;
  renderRail();
  applyView();
  el.botName.focus();
}

async function submitBotForm(e: Event): Promise<void> {
  e.preventDefault();
  el.botFormError.hidden = true;
  try {
    const bot = await api.createBot({ name: el.botName.value, job: el.botJob.value, shape: shapeOf(pickedShape()), color: colorOf(pickedColor()) });
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
  state.roomFormOpen = false;
  state.settingsOpen = false;
  renderRail();
  applyView();
}

function openSettings(): void {
  state.settingsOpen = true;
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
    el.phoneUrls.replaceChildren(...ph.urls.map((u) => {
      const li = document.createElement('li');
      const code = document.createElement('code');
      code.className = 'cmd';
      code.textContent = u;
      li.append(code);
      return li;
    }));
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
el.botCancel.addEventListener('click', closeForms);
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
