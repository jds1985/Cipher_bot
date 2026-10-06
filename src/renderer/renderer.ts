import type { Bot, Chat, ChatEvent, CipherApi, Message, SetupState } from '../shared/types';
import { decideView, setupCopy } from './view.js';
import { botIconSrc } from './botIcon.js';

declare global {
  interface Window { cipher: CipherApi }
}

const api = window.cipher;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const el = {
  splash: $('splash'),
  botList: $('bot-list'), chatList: $('chat-list'), chatsHead: $('chats-head'),
  newBot: $<HTMLButtonElement>('new-bot'), newChat: $<HTMLButtonElement>('new-chat'),
  formView: $('bot-form-view'), chatView: $('chat-view'), setupView: $('setup-view'),
  form: $<HTMLFormElement>('bot-form'), botName: $<HTMLInputElement>('bot-name'), botJob: $<HTMLTextAreaElement>('bot-job'),
  botFormError: $('bot-form-error'), botCancel: $<HTMLButtonElement>('bot-cancel'),
  setupText: $('setup-text'), setupProgress: $<HTMLProgressElement>('setup-progress'), setupDetail: $('setup-detail'),
  setupGetEngine: $<HTMLButtonElement>('setup-get-engine'), setupRetry: $<HTMLButtonElement>('setup-retry'),
  chatBotIcon: $<HTMLImageElement>('chat-bot-icon'), chatBotName: $('chat-bot-name'), chatTitle: $('chat-title'), chatTools: $<HTMLInputElement>('chat-tools'),
  chatFolderLabel: $('chat-folder-label'), chatFolderPick: $<HTMLButtonElement>('chat-folder-pick'),
  messages: $('messages'), composer: $<HTMLFormElement>('composer'), input: $<HTMLTextAreaElement>('input'),
  send: $<HTMLButtonElement>('send'), stop: $<HTMLButtonElement>('stop'),
};

const state = {
  bots: [] as Bot[],
  chats: [] as Chat[],
  messages: [] as Message[],
  botId: null as number | null,
  chatId: null as number | null,
  live: '',
  error: null as string | null,
  busy: new Set<number>(),
  formOpen: false,
  setup: { phase: 'checking', percent: null, completed: 0, total: 0, message: null } as SetupState,
};

const currentBot = () => state.bots.find((b) => b.id === state.botId) ?? null;
const currentChat = () => state.chats.find((c) => c.id === state.chatId) ?? null;

function node(tag: string, cls?: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** A bot's icon from Liz's set (decorative: the name is always next to it). */
function botIcon(b: Bot, size: number): HTMLImageElement {
  const img = document.createElement('img');
  img.className = 'bot-icon';
  img.src = botIconSrc(b.icon);
  img.alt = '';
  img.width = size;
  img.height = size;
  return img;
}

/** Decide what the main area shows (see view.ts). */
function applyView(): void {
  const view = decideView({ botCount: state.bots.length, formOpen: state.formOpen, setup: state.setup });
  el.formView.hidden = view !== 'form';
  el.setupView.hidden = view !== 'setup';
  el.chatView.hidden = view !== 'chat';
  el.botCancel.hidden = state.bots.length === 0; // nothing to go back to on first run
  if (view === 'setup') renderSetup();
  if (view === 'chat') renderChat();
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

// ---------- sidebar ----------
function renderBots(): void {
  el.botList.replaceChildren(...state.bots.map((b) => {
    const li = node('li', b.id === state.botId ? 'bot active' : 'bot');
    li.append(botIcon(b, 28), node('span', 'name', b.name));
    if (b.toolsEnabled) li.append(node('span', 'tag', 'reads files'));
    li.title = b.name;
    li.addEventListener('click', () => void selectBot(b.id));
    return li;
  }));
}

function renderChats(): void {
  el.chatsHead.hidden = state.botId === null;
  el.chatList.replaceChildren(...state.chats.map((c) => {
    const li = node('li', c.id === state.chatId ? 'active' : '', c.title);
    li.title = c.title;
    li.addEventListener('click', () => void selectChat(c.id));
    return li;
  }));
}

async function loadBots(): Promise<void> {
  state.bots = await api.listBots();
  renderBots();
}

async function selectBot(botId: number): Promise<void> {
  state.formOpen = false;
  state.botId = botId;
  state.chats = await api.listChats(botId);
  renderBots();
  if (state.chats.length) await selectChat(state.chats[0].id);
  else await newChat();
}

async function newChat(): Promise<void> {
  if (state.botId === null) return;
  const chat = await api.createChat(state.botId);
  state.chats = await api.listChats(state.botId);
  await selectChat(chat.id);
}

async function selectChat(chatId: number): Promise<void> {
  state.chatId = chatId;
  state.messages = await api.listMessages(chatId);
  state.live = '';
  state.error = null;
  renderChats();
  applyView(); // renders the chat once it's visible, so scrolling to the latest message works
  if (!el.chatView.hidden) el.input.focus();
}

// ---------- chat view ----------
function toolCallLabel(m: Message): string {
  return (m.toolCalls ?? []).map((c) => {
    const p = (c.function?.arguments as { path?: unknown })?.path;
    return typeof p === 'string' ? p : '';
  }).join(', ');
}

function renderChat(): void {
  const bot = currentBot();
  const chat = currentChat();
  if (!bot || !chat) return;
  const iconSrc = botIconSrc(bot.icon);
  if (el.chatBotIcon.getAttribute('src') !== iconSrc) el.chatBotIcon.src = iconSrc;
  el.chatBotName.textContent = bot.name;
  el.chatTitle.textContent = chat.title;
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
  el.send.hidden = busy;
  el.stop.hidden = !busy;
}

function updateLive(): void {
  const live = el.messages.querySelector('.msg.live');
  if (live) {
    live.textContent = state.live;
    el.messages.scrollTop = el.messages.scrollHeight;
  } else renderChat();
}

async function send(): Promise<void> {
  const chat = currentChat();
  const text = el.input.value.trim();
  if (!chat || !text || state.busy.has(chat.id)) return;
  state.error = null;
  state.live = '';
  state.busy.add(chat.id);
  el.input.value = '';
  renderChat();
  try {
    await api.sendMessage(chat.id, text);
  } catch (e) {
    state.busy.delete(chat.id);
    state.error = e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e);
    el.input.value = text;
    renderChat();
  }
}

async function onChatEvent(ev: ChatEvent): Promise<void> {
  if (ev.type === 'done' || ev.type === 'error') {
    state.busy.delete(ev.chatId);
    if (state.botId !== null) {
      state.chats = await api.listChats(state.botId);
      renderChats();
    }
  }
  if (ev.chatId !== state.chatId) return;
  switch (ev.type) {
    case 'token':
      state.live += ev.text;
      updateLive();
      return;
    case 'message':
      state.messages.push(ev.message);
      if (ev.message.role === 'assistant') state.live = '';
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

// ---------- create a Cipher bot ----------
function openBotForm(): void {
  el.form.reset();
  el.botFormError.hidden = true;
  state.formOpen = true;
  applyView();
  el.botName.focus();
}

async function submitBotForm(e: Event): Promise<void> {
  e.preventDefault();
  el.botFormError.hidden = true;
  try {
    const bot = await api.createBot({ name: el.botName.value, job: el.botJob.value });
    state.formOpen = false;
    await loadBots();
    await selectBot(bot.id);
  } catch (err) {
    el.botFormError.textContent = err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err);
    el.botFormError.hidden = false;
  }
}

async function replaceBot(updated: Bot): Promise<void> {
  state.bots = state.bots.map((b) => (b.id === updated.id ? updated : b));
  renderBots();
  renderChat();
}

// ---------- wiring ----------
el.newBot.addEventListener('click', openBotForm);
el.botCancel.addEventListener('click', () => { state.formOpen = false; applyView(); });
el.form.addEventListener('submit', (e) => void submitBotForm(e));
el.setupGetEngine.addEventListener('click', () => void api.openEngineDownload());
el.setupRetry.addEventListener('click', () => void api.startSetup());
api.onSetupState(onSetupState);
el.newChat.addEventListener('click', () => void newChat());
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
el.stop.addEventListener('click', () => { if (state.chatId !== null) void api.stop(state.chatId); });
api.onChatEvent((ev) => void onChatEvent(ev));

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
    await loadBots();
    if (state.bots.length) await selectBot(state.bots[0].id);
    else applyView();
  } finally {
    window.setTimeout(hideSplash, Math.max(0, 700 - (performance.now() - splashStart)));
  }
}

void init();
