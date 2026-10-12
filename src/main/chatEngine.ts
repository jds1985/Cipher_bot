import type { Bot, ChatEvent, Message, ToolCall } from '../shared/types';
import type { CipherDb } from './db';
import { executeToolCall, READ_FILE_TOOL } from './readFileTool';
import { OLLAMA_HOST, streamChat, type OllamaMessage } from './ollama';
import { CALCULATOR_TOOL, runCalculator } from './calculator';
import { WRITE_FILE_TOOL } from './fileWrite';
import { CHECKLIST_TOOL } from './checklist';
import { NOT_CONFIRMED_RESULT, OFF_RESULT, WEB_SEARCH_TOOL, formatResultsForModel, normalizeQuery, type SearchResult } from './webSearch';

/** Maximum model→tool→model round trips per user message. */
export const MAX_TOOL_ROUNDS = 5;

const TOOL_HINT =
  'You have one tool, read_file, which reads text files from a folder the user shared with you. ' +
  'Use it when the user asks about the contents of their files. Paths are relative to that folder.';
const SECOND_FOLDER_HINT =
  'The user also attached a second folder. To read from it, call read_file with folder set to "second".';

const SEARCH_HINT =
  'You can also use web_search when the user needs current information from the web. The user sees your exact query and ' +
  'must press Search first. If the result is "User did not confirm the search", do not search again for it: answer ' +
  'without web results and say that no search was made. Never claim you searched unless you got results. Cite the links you use.';

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
}

const WRITE_HINT = 'You can also use write_file to save a text file into the shared folder. The user is asked first and may cancel; ' +
  'if they cancel, do not try again unless they ask. Never say a file was written unless the result says so.';
const CHECKLIST_HINT = "You can use checklist_add to add an item to the user's checklist. The user must approve each item.";

export interface EngineDeps {
  db: CipherDb;
  model: string;
  emit: (e: ChatEvent) => void;
  host?: string;
  fetchImpl?: typeof fetch;
  /** Phone link / tests: never offer tools for this turn, regardless of bot settings. */
  forceToolsOff?: boolean;
  /** Routine turns: the user message is marked as sent by the bot's routine. */
  fromRoutine?: boolean;
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
  if (m.image) parts.push(`[The user attached an image: ${m.image.split(/[\\/]/).pop()}]`);
  parts.push(m.content);
  return parts.join('\n\n');
}

/** v1.21: reply length → a line in the system prompt and Ollama's num_predict cap (normal adds neither). */
export const REPLY_LENGTH_HINT: Record<'short' | 'normal' | 'long', string> = {
  short: 'Keep replies short: a few sentences at most, unless the user asks for more.',
  normal: '',
  long: 'Give thorough, detailed replies with explanations and examples when useful.',
};
export const REPLY_NUM_PREDICT: Record<'short' | 'normal' | 'long', number | null> = { short: 256, normal: null, long: 2048 };
export function replyOptions(len: 'short' | 'normal' | 'long' | undefined): Record<string, number> | undefined {
  const n = REPLY_NUM_PREDICT[len ?? 'normal'];
  return n ? { num_predict: n } : undefined;
}

/** v1.19: the user's memory note for this bot, sent in the system prompt of every chat. */
export function memoryBlock(note: string | undefined | null): string {
  const t = (note ?? '').trim();
  return t ? `Memory note from the user (things to remember in every chat):\n${t}` : '';
}

/** Convert stored messages into Ollama's chat format. */
export function buildHistory(bot: Bot, messages: Message[], searchOn = false, actions: { write?: boolean; checklist?: boolean } = {}): OllamaMessage[] {
  const out: OllamaMessage[] = [];
  const system = [bot.systemPrompt.trim(), bot.toolsEnabled ? TOOL_HINT : '', bot.toolsEnabled && bot.secondFolderPath ? SECOND_FOLDER_HINT : '',
    searchOn ? SEARCH_HINT : '', actions.write ? WRITE_HINT : '', actions.checklist ? CHECKLIST_HINT : '', REPLY_LENGTH_HINT[bot.replyLength ?? 'normal'], memoryBlock(bot.memoryNote)].filter(Boolean).join('\n\n');
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (m.role === 'tool') {
      out.push({ role: 'tool', content: m.content, tool_name: m.toolName ?? 'read_file' });
    } else if (m.role === 'assistant') {
      const msg: OllamaMessage = { role: 'assistant', content: m.content };
      if (m.toolCalls?.length) msg.tool_calls = m.toolCalls;
      out.push(msg);
    } else {
      out.push({ role: 'user', content: userContentForModel(m) });
    }
  }
  return out;
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
  const toolsOn = bot.toolsEnabled && !deps.forceToolsOff;
  // v1.22: never for routines or forced-off turns (the phone), only when main passed the hooks (desktop).
  const actionsOn = !!deps.actions && !deps.fromRoutine && !deps.forceToolsOff;
  const writeOn = actionsOn && toolsOn && !!bot.folderPath;

  emit({ chatId, type: 'message', message: db.addMessage({ chatId, role: 'user', content: text, routine: deps.fromRoutine === true,
    quote: deps.userExtras?.quote ?? null, image: deps.userExtras?.image ?? null }) });

  // v1.18: web_search is offered only while Online is on, re-checked every round: turning Online off mid-reply
  // removes it from the rest of the reply.
  const searchOn = (): boolean => !deps.fromRoutine && !!deps.search && deps.search.isOnline();
  const offeredTools = (): unknown[] | undefined => {
    // The calculator is local (no network, no files): offered in every 1:1 chat turn except routines.
    const t: unknown[] = [...(toolsOn ? [READ_FILE_TOOL] : []), ...(searchOn() ? [WEB_SEARCH_TOOL] : []), ...(deps.fromRoutine ? [] : [CALCULATOR_TOOL]),
      ...(writeOn ? [WRITE_FILE_TOOL] : []), ...(actionsOn ? [CHECKLIST_TOOL] : [])];
    return t.length ? t : undefined;
  };

  let partial = '';
  try {
    for (let round = 0; ; round++) {
      partial = '';
      const { content, toolCalls } = await streamChat({
        model: deps.model,
        options: replyOptions(bot.replyLength),
        host: deps.host ?? OLLAMA_HOST,
        fetchImpl: deps.fetchImpl,
        messages: buildHistory({ ...bot, toolsEnabled: toolsOn }, db.listMessages(chatId), searchOn(), { write: writeOn, checklist: actionsOn }),
        tools: offeredTools(),
        signal,
        onToken: (t) => { partial += t; emit({ chatId, type: 'token', text: t }); },
      });
      partial = '';
      // Only calls to tools offered this round count; anything else is ignored (as before v1.19).
      const offeredNames = new Set(((offeredTools() ?? []) as { function: { name: string } }[]).map((t) => t.function.name));
      const wantsTools = toolCalls.some((c) => offeredNames.has(c?.function?.name ?? 'read_file'));
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
        if (call?.function?.name === 'write_file' || call?.function?.name === 'checklist_add') {
          const name = call.function.name;
          const args = parseArgs(call.function.arguments);
          let r: { ok: boolean; path?: string; content: string; text?: string };
          if (name === 'write_file') {
            r = writeOn && deps.actions ? await deps.actions.writeFile(chatId, bot, args.path, args.content)
              : { ok: false, path: '', content: 'Error: writing files is not available here.' };
          } else {
            r = actionsOn && deps.actions ? await deps.actions.addChecklist(chatId, bot, args.text)
              : { ok: false, content: 'Error: the checklist is not available here.' };
          }
          if (signal.aborted) throw new Error('Stopped.');
          emit({ chatId, type: 'tool', name, path: r.path ?? r.text ?? '', ok: r.ok, detail: r.content });
          const actMsg = db.addMessage({ chatId, role: 'tool', content: r.content, toolName: name });
          emit({ chatId, type: 'message', message: actMsg });
          continue;
        }
        if (!toolsOn) {
          const off = db.addMessage({ chatId, role: 'tool', content: 'Error: File reading is off for this Cipher bot.', toolName: 'read_file' });
          emit({ chatId, type: 'message', message: off });
          continue;
        }
        const outcome = await executeToolCall(call, bot.folderPath, bot.secondFolderPath);
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
