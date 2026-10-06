import type { Bot, Chat, ChatEvent, CipherApi, Message, ModelsState, OllamaStatus, PullEvent } from '../shared/types';

declare global {
  interface Window { cipher: CipherApi }
}

const api = window.cipher;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const el = {
  botList: $('bot-list'), chatList: $('chat-list'), chatsHead: $('chats-head'),
  newBot: $<HTMLButtonElement>('new-bot'), emptyNewBot: $<HTMLButtonElement>('empty-new-bot'), newChat: $<HTMLButtonElement>('new-chat'),
  banner: $('banner'), empty: $('empty'), formView: $('bot-form-view'), chatView: $('chat-view'),
  form: $<HTMLFormElement>('bot-form'), botName: $<HTMLInputElement>('bot-name'), botPrompt: $<HTMLTextAreaElement>('bot-prompt'),
  botTools: $<HTMLInputElement>('bot-tools'), botFolderRow: $('bot-folder-row'), botFolderPick: $<HTMLButtonElement>('bot-folder-pick'),
  botFolderLabel: $('bot-folder-label'), botFormError: $('bot-form-error'), botCancel: $<HTMLButtonElement>('bot-cancel'),
  chatBotName: $('chat-bot-name'), chatTitle: $('chat-title'), chatTools: $<HTMLInputElement>('chat-tools'),
  chatFolderLabel: $('chat-folder-label'), chatFolderPick: $<HTMLButtonElement>('chat-folder-pick'),
  messages: $('messages'), composer: $<HTMLFormElement>('composer'), input: $<HTMLTextAreaElement>('input'),
  send: $<HTMLButtonElement>('send'), stop: $<HTMLButtonElement>('stop'),
  openModels: $<HTMLButtonElement>('open-models'), modelsView: $('models-view'), modelsList: $('models-list'),
  modelsNote: $('models-note'), modelsClose: $<HTMLButtonElement>('models-close'),
};

interface PullUi { status: string; percent: number | null; completed: number; total: number; error: string | null; running: boolean }

const state = {
  bots: [] as Bot[],
  chats: [] as Chat[],
  messages: [] as Message[],
  botId: null as number | null,
  chatId: null as number | null,
  live: '',
  error: null as string | null,
  busy: new Set<number>(),
  newBotFolder: null as string | null,
  status: null as OllamaStatus | null,
  models: null as ModelsState | null,
  pulls: new Map<string, PullUi>(),
};

const currentBot = () => state.bots.find((b) => b.id === state.botId) ?? null;
const currentChat = () => state.chats.find((c) => c.id === state.chatId) ?? null;

function node(tag: string, cls?: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function showView(which: 'empty' | 'form' | 'chat' | 'models'): void {
  el.empty.hidden = which !== 'empty';
  el.formView.hidden = which !== 'form';
  el.chatView.hidden = which !== 'chat';
  el.modelsView.hidden = which !== 'models';
}

// ---------- Ollama status banner ----------
let statusTimer: number | undefined;
async function refreshStatus(): Promise<void> {
  state.status = await api.ollamaStatus();
  const s = state.status;
  el.banner.replaceChildren();
  el.banner.hidden = !s.problem;
  window.clearTimeout(statusTimer);
  if (s.problem) {
    el.banner.append(node('span', '', s.problem));
    if (s.fixCommand) {
      el.banner.append(node('span', 'muted', 'Run:'), node('code', '', s.fixCommand));
    }
    if (s.running && !s.modelPresent) {
      const dl = node('button', 'small', 'Download in Cipher');
      dl.addEventListener('click', () => void openModels());
      el.banner.append(dl);
    }
    const retry = node('button', 'secondary small', 'Check again');
    retry.addEventListener('click', () => void refreshStatus());
    el.banner.append(retry);
    statusTimer = window.setTimeout(() => void refreshStatus(), 5000);
  }
}

// ---------- sidebar ----------
function renderBots(): void {
  el.botList.replaceChildren(...state.bots.map((b) => {
    const li = node('li', b.id === state.botId ? 'active' : '', b.name);
    if (b.toolsEnabled) li.append(node('span', 'tag', 'tools'));
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
  showView('chat'); // show first so scrolling to the latest message works
  renderChats();
  renderChat();
  el.input.focus();
}

// ---------- chat view ----------
function toolCallLabel(m: Message): string {
  return (m.toolCalls ?? []).map((c) => {
    const p = (c.function?.arguments as { path?: unknown })?.path;
    return `${c.function?.name ?? 'tool'}(${typeof p === 'string' ? p : ''})`;
  }).join(', ');
}

function renderChat(): void {
  const bot = currentBot();
  const chat = currentChat();
  if (!bot || !chat) return;
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
      if (m.toolCalls?.length) items.push(node('div', 'msg note', `Using tool: ${toolCallLabel(m)}`));
    } else {
      const bad = m.content.startsWith('Error:');
      items.push(node('div', `msg note${bad ? ' bad' : ''}`, bad ? `read_file failed: ${m.content.slice(7)}` : `read_file returned ${m.content.length} characters`));
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
      void refreshStatus();
      break;
    case 'done':
      state.live = '';
      break;
  }
  renderChat();
}

// ---------- new bot form ----------
function openBotForm(): void {
  el.form.reset();
  state.newBotFolder = null;
  el.botFolderLabel.textContent = 'No folder chosen';
  el.botFolderRow.hidden = true;
  el.botFormError.hidden = true;
  showView('form');
  el.botName.focus();
}

async function submitBotForm(e: Event): Promise<void> {
  e.preventDefault();
  el.botFormError.hidden = true;
  try {
    const bot = await api.createBot({
      name: el.botName.value,
      systemPrompt: el.botPrompt.value,
      toolsEnabled: el.botTools.checked,
      folderPath: el.botTools.checked ? state.newBotFolder : null,
    });
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

// ---------- models screen ----------
function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  return `${Math.round(n / 1e3)} KB`;
}

async function openModels(): Promise<void> {
  showView('models');
  renderModels();
  await refreshModels();
}

async function refreshModels(): Promise<void> {
  state.models = await api.listModels();
  renderModels();
}

function renderModels(): void {
  const m = state.models;
  if (!m) { el.modelsList.replaceChildren(node('p', 'muted', 'Checking Ollama…')); return; }
  const notes: string[] = [];
  if (!m.ollamaRunning) notes.push('Ollama is not running at http://127.0.0.1:11434. Start it (ollama serve), then reopen this screen.');
  if (m.envOverride) notes.push(`CIPHER_MODEL is set to "${m.envOverride}", which overrides the choice below until it is unset.`);
  el.modelsNote.textContent = notes.join(' ');
  el.modelsNote.hidden = notes.length === 0;

  el.modelsList.replaceChildren(...m.models.map((info) => {
    const pull = state.pulls.get(info.name);
    const inUse = m.active === info.name;
    const row = node('div', `model-row${inUse ? ' active' : ''}`);
    const head = node('div', 'row');
    const title = node('div');
    title.append(node('strong', '', info.label), node('span', 'muted', `  ${info.name} · ${info.size}`));
    if (info.downloaded) title.append(node('span', 'badge ok', 'Downloaded'));
    if (inUse) title.append(node('span', 'badge use', 'In use'));
    else if (m.envOverride && m.selected === info.name) title.append(node('span', 'badge', 'Selected (overridden)'));
    const actions = node('div', 'row');
    if (pull?.running) {
      const cancel = node('button', 'secondary small', 'Cancel');
      cancel.addEventListener('click', () => void api.cancelPull(info.name));
      actions.append(cancel);
    } else {
      if (!info.downloaded) {
        const dl = node('button', 'small', 'Download') as HTMLButtonElement;
        dl.disabled = !m.ollamaRunning;
        dl.addEventListener('click', () => void startPull(info.name));
        actions.append(dl);
      }
      const chosen = m.selected === info.name || (m.selected === null && inUse);
      if (!chosen) {
        const use = node('button', 'secondary small', 'Use this model') as HTMLButtonElement;
        use.addEventListener('click', async () => {
          state.models = await api.selectModel(info.name);
          renderModels();
          void refreshStatus();
        });
        actions.append(use);
      }
    }
    head.append(title, actions);
    row.append(head, node('div', 'muted', info.note));
    if (pull) {
      if (pull.running) {
        const bar = document.createElement('progress');
        bar.max = 100;
        if (pull.percent !== null) bar.value = pull.percent;
        row.append(bar);
        const detail = pull.total > 0 ? `${pull.percent ?? 0}% · ${formatBytes(pull.completed)} of ${formatBytes(pull.total)}` : pull.status;
        row.append(node('div', 'muted', pull.total > 0 ? `${pull.status} · ${detail}` : detail));
      } else if (pull.error) {
        row.append(node('div', 'error', pull.error));
      } else {
        row.append(node('div', 'muted', pull.status));
      }
    }
    return row;
  }));
}

async function startPull(name: string): Promise<void> {
  state.pulls.set(name, { status: 'Starting download…', percent: null, completed: 0, total: 0, error: null, running: true });
  renderModels();
  try {
    await api.pullModel(name);
  } catch (e) {
    state.pulls.set(name, { status: '', percent: null, completed: 0, total: 0, running: false,
      error: e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e) });
    renderModels();
  }
}

async function onPullEvent(ev: PullEvent): Promise<void> {
  const prev = state.pulls.get(ev.model);
  if (ev.type === 'progress') {
    state.pulls.set(ev.model, { status: ev.status, percent: ev.percent, completed: ev.completed, total: ev.total, error: null, running: true });
  } else if (ev.type === 'done') {
    state.pulls.set(ev.model, { ...(prev ?? { percent: 100, completed: 0, total: 0 }), status: 'Download complete.', error: null, running: false } as PullUi);
    void refreshStatus();
    await refreshModels();
    return;
  } else if (ev.type === 'cancelled') {
    state.pulls.set(ev.model, { status: 'Download cancelled. Starting again resumes where it stopped.', percent: null, completed: 0, total: 0, error: null, running: false });
  } else {
    state.pulls.set(ev.model, { status: '', percent: null, completed: 0, total: 0, error: ev.error, running: false });
  }
  if (!el.modelsView.hidden) renderModels();
}

// ---------- wiring ----------
el.newBot.addEventListener('click', openBotForm);
el.emptyNewBot.addEventListener('click', openBotForm);
el.botCancel.addEventListener('click', () => showView(state.chatId !== null ? 'chat' : 'empty'));
el.openModels.addEventListener('click', () => void openModels());
el.modelsClose.addEventListener('click', () => showView(state.chatId !== null ? 'chat' : 'empty'));
api.onPullEvent((ev) => void onPullEvent(ev));
el.form.addEventListener('submit', (e) => void submitBotForm(e));
el.botTools.addEventListener('change', () => { el.botFolderRow.hidden = !el.botTools.checked; });
el.botFolderPick.addEventListener('click', async () => {
  const folder = await api.pickFolder();
  if (folder) { state.newBotFolder = folder; el.botFolderLabel.textContent = folder; }
});
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

async function init(): Promise<void> {
  void refreshStatus();
  await loadBots();
  if (state.bots.length) await selectBot(state.bots[0].id);
  else showView('empty');
}

void init();
