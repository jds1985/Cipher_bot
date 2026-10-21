import type { Bot, ChatEvent, Message, ToolCall } from '../shared/types';
import type { CipherDb } from './db';
import { executeToolCall, READ_FILE_TOOL } from './readFileTool';
import { trimHistory } from './historyBudget';
import type { ModelManifest } from './modelManifest';
import { streamChat, type BackendEndpoint, type ChatMessage } from './backend';
import { historyBudgetTokens } from './historyBudget';
import { CALCULATOR_TOOL, runCalculator } from './calculator';
import { WRITE_FILE_TOOL } from './fileWrite';
import { DRAFT_FILE_TOOL } from './drafts';
import { CHECKLIST_TOOL } from './checklist';
import { isToolName, TOOL_LABELS, toolSwitches, type ToolName } from './toolSwitches';
import { NOT_CONFIRMED_RESULT, OFF_RESULT, WEB_SEARCH_TOOL, formatResultsForModel, normalizeQuery, type SearchResult } from './webSearch';

/** Maximum model→tool→model round trips per user message. */
export const MAX_TOOL_ROUNDS = 5;

const TOOL_HINT = 'Tool read_file reads files in the folder the user shared (relative paths).';
const SECOND_FOLDER_HINT = 'For the second folder, call read_file with folder "second".';

const SHARED_FOLDER_HINT = 'For the shared folder (read-only), call read_file with folder "shared".';

const SEARCH_HINT = 'Tool web_search needs the user to press Search. If not confirmed, answer without it and say so. Cite links.';

/** v1.18: what main provides for web search. Absent for rooms, phone link and routines (they never search). */
export interface SearchHooks {
  /** Live Online state; checked before offering the tool, before asking, and again before and after the request. */
  isOnline: () => boolean;
  /** Show the confirm card with this exact query. Resolves to a one-time token on Search, or null (Cancel, timeout, Online off, lock). */
  confirm: (chatId: number, query: string, signal: AbortSignal) => Promise<string | null>;
  /** Send the search; main verifies Online and the token for this exact query and chat at request time. */
  run: (chatId: number, query: string, token: string, signal: AbortSignal) => Promise<SearchResult[]>;
}

/**
 * v1.22: write_file and checklist_add. Main provides these ONLY for desktop 1:1 turns (never for the phone, rooms or
 * routines). Each one shows main's native confirm dialog and acts only through a one-time token; the engine never
 * writes or adds anything itself. Both return the text the bot sees.
 */
export interface ActionHooks {
  writeFile: (chatId: number, bot: Bot, path: unknown, content: unknown) => Promise<{ ok: boolean; path: string; content: string }>;
  addChecklist: (chatId: number, bot: Bot, text: unknown) => Promise<{ ok: boolean; content: string; text: string }>;
  /** v1.25: keep a draft in main (nothing is written); the user saves it later through the v1.22 token confirm. */
  draftFile?: (chatId: number, bot: Bot, path: unknown, content: unknown) => Promise<{ ok: boolean; path: string; content: string }>;
}

const WRITE_HINT = 'Tool write_file saves a file after the user confirms. Never claim it was written unless the result says so.';
const CHECKLIST_HINT = 'Tool checklist_add adds an item after the user approves.';

/** The running Cipher model, as main sees it (manifest + live endpoint of the bundled cipher-serve). */
export type ModelProfile = Pick<ModelManifest, 'id' | 'nCtx' | 'maxReplyTokens' | 'sampling' | 'systemPrompt' | 'capabilities'>;

export interface EngineDeps {
  db: CipherDb;
  model: ModelProfile;
  /** Live endpoint of cipher-serve (null while it is starting or down). */
  endpoint: () => BackendEndpoint | null;
  emit: (e: ChatEvent) => void;
  fetchImpl?: typeof fetch;
  /** Phone link / tests: never offer tools for this turn, regardless of bot settings. */
  forceToolsOff?: boolean;
  /** Routine turns: the user message is marked as sent by the bot's routine. */
  fromRoutine?: boolean;
  /** v1.24: the app-wide shared folder (main's setting, read live), or null. Read only with the Files switch on. */
  sharedFolder?: () => string | null;
  /** v1.23: a reminder turn (always with fromRoutine): files and calculator follow the switches; nothing else. */
  reminder?: boolean;
  /** v1.18: web search hooks (1:1 chats on the desktop and, since v1.19, the phone; never routines). */
  search?: SearchHooks;
  /** v1.20: the quoted message's text (snapshot) and a dropped image's folder-relative path for this user message. */
  userExtras?: { quote?: string | null; image?: string | null };
  /** v1.22: desktop-only write_file / checklist_add hooks (absent for phone, routines, rooms and tests by default). */
  actions?: ActionHooks;
}

/** v1.20: how a quote and an image are shown to the (text-only) model. */
export function userContentForModel(m: Pick<Message, 'content' | 'quote' | 'image'>): string {
  const parts: string[] = [];
  if (m.quote) parts.push(`Quoting an earlier message:\n${m.quote.split('\n').map((l) => `> ${l}`).join('\n')}`);
  if (m.image) parts.push(`[The user attached an image: ${m.image.startsWith('pasted:') ? 'a pasted screenshot' : m.image.split(/[\\/]/).pop()}]`);
  parts.push(m.content);
  return parts.join('\n\n');
}

/** v1.21: reply length → a short line in the system prompt and a reply-token cap that fits the model's context. */
export const REPLY_LENGTH_HINT: Record<'short' | 'normal' | 'long', string> = {
  short: 'Keep replies short.',
  normal: '',
  long: 'Give detailed replies.',
};
/** Reply tokens: short 120, normal = the manifest's maxReplyTokens (300 on the 135M), long = half the context. */
export function replyTokens(len: 'short' | 'normal' | 'long' | undefined, model: Pick<ModelProfile, 'nCtx' | 'maxReplyTokens'>): number {
  const l = len ?? 'normal';
  if (l === 'short') return Math.min(120, model.maxReplyTokens);
  if (l === 'long') return Math.max(model.maxReplyTokens, Math.floor(model.nCtx / 2));
  return model.maxReplyTokens;
}

/** v1.19: the user's memory note for this bot, sent in the system prompt of every chat. */
export function memoryBlock(note: string | undefined | null): string {
  const t = (note ?? '').trim();
  return t ? `Remember: ${t}` : '';
}

/** Convert stored messages into the model's chat messages, trimmed to the model's token budget. */
export function buildHistory(bot: Bot, messages: Message[], model: ModelProfile, searchOn = false, actions: { write?: boolean; checklist?: boolean; shared?: boolean } = {}): ChatMessage[] {
  const out: ChatMessage[] = [];
  const system = [model.systemPrompt, bot.name ? `Your name is ${bot.name}.` : '', bot.systemPrompt.trim(), bot.toolsEnabled ? TOOL_HINT : '', bot.toolsEnabled && bot.secondFolderPath ? SECOND_FOLDER_HINT : '', bot.toolsEnabled && actions.shared ? SHARED_FOLDER_HINT : '',
    searchOn ? SEARCH_HINT : '', actions.write ? WRITE_HINT : '', actions.checklist ? CHECKLIST_HINT : '', REPLY_LENGTH_HINT[bot.replyLength ?? 'normal'], memoryBlock(bot.memoryNote)].filter(Boolean).join('\n\n');
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (m.role === 'tool') {
      out.push({ role: 'tool', content: m.content, tool_name: m.toolName ?? 'read_file' });
    } else if (m.role === 'assistant') {
      const msg: ChatMessage = { role: 'assistant', content: m.content };
      if (m.toolCalls?.length) msg.tool_calls = m.toolCalls;
      out.push(msg);
    } else {
      out.push({ role: 'user', content: userContentForModel(m) });
    }
  }
  return trimHistory(out, historyBudgetTokens(model.nCtx, replyTokens(bot.replyLength, model)));
}

/**
 * Handle one user message: save it, stream the reply, run read_file when the model asks
 * (only if the bot has tools on), feed results back and continue until a plain answer.
 */
export async function runChatTurn(deps: EngineDeps, chatId: number, userText: string, signal: AbortSignal): Promise<void> {
  const { db, emit } = deps;
  const chat = db.getChat(chatId);
  if (!chat) throw new Error('Chat not found.');
  const bot = db.getBot(chat.botId);
  if (!bot) throw new Error('Cipher bot not found.');
  const text = userText.trim();
  if (!text) throw new Error('Message is empty.');
  // v1.23: per-bot tool switches (bot.tools), kept in main and re-read from the database every round and again
  // right before any tool runs, so turning one off mid-reply takes effect at once. A tool is offered only if allowed()
  // and a call to it runs only if allowed() at that moment; otherwise the call is refused (even if the model invents it).
  const liveBot = (): Bot => db.getBot(bot.id) ?? bot;
  const allowed = (name: ToolName): boolean => {
    const b = liveBot();
    const t = toolSwitches(b);
    const filesOn = t.files && !deps.forceToolsOff;
    // v1.22: write/checklist only when main passed its native-confirm hooks (desktop 1:1); never routines, reminders or the phone.
    const actionsOn = !!deps.actions && !deps.fromRoutine && !deps.forceToolsOff;
    // Models without verified function calling (the 135M stand-in) are offered no tools at all: nothing is faked.
    if (!deps.model.capabilities.toolCalling) return false;
    switch (name) {
      case 'read_file': return filesOn;
      case 'web_search': return t.search && !deps.fromRoutine && !!deps.search && deps.search.isOnline();
      // The calculator is local (no network, no files). Routines never get it; reminders do when it's switched on.
      case 'calculator': return t.calculator && (!deps.fromRoutine || deps.reminder === true);
      case 'write_file': return t.write && filesOn && !!b.folderPath && actionsOn;
      case 'draft_file': return t.write && filesOn && !!b.folderPath && actionsOn && !!deps.actions?.draftFile;
      case 'checklist_add': return t.checklist && actionsOn;
    }
  };

  emit({ chatId, type: 'message', message: db.addMessage({ chatId, role: 'user', content: text, routine: deps.fromRoutine === true && !deps.reminder,
    reminder: deps.reminder === true, quote: deps.userExtras?.quote ?? null, image: deps.userExtras?.image ?? null }) });

  const searchOn = (): boolean => allowed('web_search');
  const offeredTools = (): unknown[] | undefined => {
    const t: unknown[] = [...(allowed('read_file') ? [READ_FILE_TOOL] : []), ...(searchOn() ? [WEB_SEARCH_TOOL] : []),
      ...(allowed('calculator') ? [CALCULATOR_TOOL] : []), ...(allowed('write_file') ? [WRITE_FILE_TOOL] : []), ...(allowed('draft_file') ? [DRAFT_FILE_TOOL] : []),
      ...(allowed('checklist_add') ? [CHECKLIST_TOOL] : [])];
    return t.length ? t : undefined;
  };

  let partial = '';
  try {
    for (let round = 0; ; round++) {
      partial = '';
      const { content, toolCalls } = await streamChat({
        endpoint: deps.endpoint(),
        maxTokens: replyTokens(liveBot().replyLength, deps.model),
        sampling: deps.model.sampling,
        fetchImpl: deps.fetchImpl,
        messages: buildHistory({ ...liveBot(), toolsEnabled: allowed('read_file') }, db.listMessages(chatId), deps.model, searchOn(),
          { write: allowed('write_file'), checklist: allowed('checklist_add'), shared: !!deps.sharedFolder?.() && allowed('read_file') }),
        tools: offeredTools(),
        signal,
        onToken: (t) => { partial += t; emit({ chatId, type: 'token', text: t }); },
      });
      partial = '';
      // Calls to any of Cipher Bot's tools count (offered or not: a call to a switched-off tool gets a refusal below);
      // calls to names that are not Cipher Bot tools are ignored (as before).
      // A call without a name is ignored (never treated as a file read).
      const wantsTools = toolCalls.some((c) => isToolName(c?.function?.name));
      if (wantsTools && round >= MAX_TOOL_ROUNDS) {
        const note = content || '(Stopped: your Cipher bot kept trying to read files. Try rephrasing your question.)';
        emit({ chatId, type: 'message', message: db.addMessage({ chatId, role: 'assistant', content: note }) });
        break;
      }
      if (content || wantsTools) {
        const saved = db.addMessage({ chatId, role: 'assistant', content, toolCalls: wantsTools ? toolCalls : null });
        emit({ chatId, type: 'message', message: saved });
      }
      if (!wantsTools) break;
      for (const call of toolCalls) {
        const callName = call?.function?.name;
        if (!isToolName(callName)) continue; // unnamed or unknown: ignored
        // v1.23: execution-time switch check, for every tool. Nothing runs while its switch is off.
        if (!allowed(callName)) {
          const refusal = callName === 'read_file' ? 'Error: File reading is off for this Cipher bot.' : `Error: ${TOOL_LABELS[callName]} is switched off for this Cipher bot. Do not try again.`;
          emit({ chatId, type: 'tool', name: callName, path: '', ok: false, detail: refusal });
          const off = db.addMessage({ chatId, role: 'tool', content: refusal, toolName: callName });
          emit({ chatId, type: 'message', message: off });
          continue;
        }
        if (call?.function?.name === 'web_search') {
          const s = await runSearchCall(deps, chatId, call, signal);
          emit({ chatId, type: 'tool', name: 'web_search', path: s.query, ok: s.ok, detail: s.ok ? `${s.search?.results.length ?? 0} results` : s.content });
          const searchMsg = db.addMessage({ chatId, role: 'tool', content: s.content, toolName: 'web_search', search: s.search ?? null });
          emit({ chatId, type: 'message', message: searchMsg });
          continue;
        }
        if (call?.function?.name === 'calculator') {
          const c = runCalculator(call.function.arguments);
          emit({ chatId, type: 'tool', name: 'calculator', path: '', ok: c.ok, detail: c.content });
          const calcMsg = db.addMessage({ chatId, role: 'tool', content: c.content, toolName: 'calculator' });
          emit({ chatId, type: 'message', message: calcMsg });
          continue;
        }
        if (call?.function?.name === 'write_file' || call?.function?.name === 'checklist_add' || call?.function?.name === 'draft_file') {
          const name = call.function.name;
          const args = parseArgs(call.function.arguments);
          let r: { ok: boolean; path?: string; content: string; text?: string };
          const b = liveBot();
          if (name === 'draft_file') {
            r = deps.actions?.draftFile ? await deps.actions.draftFile(chatId, b, args.path, args.content)
              : { ok: false, path: '', content: 'Error: drafting files is not available here.' };
          } else if (name === 'write_file') {
            r = deps.actions ? await deps.actions.writeFile(chatId, b, args.path, args.content)
              : { ok: false, path: '', content: 'Error: writing files is not available here.' };
          } else {
            r = deps.actions ? await deps.actions.addChecklist(chatId, b, args.text)
              : { ok: false, content: 'Error: the checklist is not available here.' };
          }
          if (signal.aborted) throw new Error('Stopped.');
          emit({ chatId, type: 'tool', name, path: r.path ?? r.text ?? '', ok: r.ok, detail: r.content });
          const actMsg = db.addMessage({ chatId, role: 'tool', content: r.content, toolName: name });
          emit({ chatId, type: 'message', message: actMsg });
          continue;
        }
        const fb = liveBot();
        // v1.24: the shared folder is read live from main's setting, right now, after allowed('read_file') passed above.
        const outcome = await executeToolCall(call, fb.folderPath, fb.secondFolderPath, deps.sharedFolder?.() ?? null);
        emit({ chatId, type: 'tool', name: outcome.name, path: outcome.path, ok: outcome.ok, detail: outcome.ok ? `${outcome.content.length} chars` : outcome.content });
        const toolMsg = db.addMessage({ chatId, role: 'tool', content: outcome.content, toolName: outcome.name || 'read_file' });
        emit({ chatId, type: 'message', message: toolMsg });
      }
    }
    emit({ chatId, type: 'done' });
  } catch (e) {
    if (signal.aborted) {
      // Keep whatever was streamed before the user pressed Stop.
      if (partial) emit({ chatId, type: 'message', message: db.addMessage({ chatId, role: 'assistant', content: partial }) });
      emit({ chatId, type: 'done' });
      return;
    }
    emit({ chatId, type: 'error', error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * One web_search call. Nothing is sent unless Online is on AND the user pressed Search for this exact query
 * (main then issues a one-time token that the request itself checks). Cancel, timeout, lock or Online off all mean
 * the bot gets a refusal and carries on without searching.
 */
export async function runSearchCall(deps: EngineDeps, chatId: number, call: ToolCall, signal: AbortSignal):
  Promise<{ ok: boolean; query: string; content: string; search?: { query: string; results: SearchResult[] } }> {
  let args: unknown = call?.function?.arguments ?? {};
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
  let query: string;
  try { query = normalizeQuery((args as { query?: unknown })?.query); } catch (e) {
    return { ok: false, query: '', content: `Error: ${e instanceof Error ? e.message : 'bad query'}` };
  }
  const hooks = deps.search;
  if (deps.fromRoutine || !hooks) return { ok: false, query, content: 'Error: web search is not available here.' };
  if (!hooks.isOnline()) return { ok: false, query, content: OFF_RESULT };
  const token = await hooks.confirm(chatId, query, signal);
  if (signal.aborted) throw new Error('Stopped.');
  if (!hooks.isOnline()) return { ok: false, query, content: OFF_RESULT };
  if (!token) return { ok: false, query, content: NOT_CONFIRMED_RESULT };
  try {
    const results = await hooks.run(chatId, query, token, signal);
    if (!hooks.isOnline()) return { ok: false, query, content: OFF_RESULT }; // turned off while it was on the way: dropped
    return { ok: true, query, content: formatResultsForModel(query, results), search: { query, results } };
  } catch (e) {
    if (signal.aborted) throw e;
    if (!hooks.isOnline()) return { ok: false, query, content: OFF_RESULT };
    return { ok: false, query, content: `Error: the web search failed (${e instanceof Error ? e.message : 'unknown error'}). Answer without web results.` };
  }
}

function parseArgs(raw: unknown): Record<string, unknown> {
  let a: unknown = raw ?? {};
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = {}; } }
  return a && typeof a === 'object' ? (a as Record<string, unknown>) : {};
}
