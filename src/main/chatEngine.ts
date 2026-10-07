import type { Bot, ChatEvent, Message } from '../shared/types';
import type { CipherDb } from './db';
import { executeToolCall, READ_FILE_TOOL } from './readFileTool';
import { OLLAMA_HOST, streamChat, type OllamaMessage } from './ollama';

/** Maximum model→tool→model round trips per user message. */
export const MAX_TOOL_ROUNDS = 5;

const TOOL_HINT =
  'You have one tool, read_file, which reads text files from a folder the user shared with you. ' +
  'Use it when the user asks about the contents of their files. Paths are relative to that folder.';

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
}

/** Convert stored messages into Ollama's chat format. */
export function buildHistory(bot: Bot, messages: Message[]): OllamaMessage[] {
  const out: OllamaMessage[] = [];
  const system = [bot.systemPrompt.trim(), bot.toolsEnabled ? TOOL_HINT : ''].filter(Boolean).join('\n\n');
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (m.role === 'tool') {
      out.push({ role: 'tool', content: m.content, tool_name: m.toolName ?? 'read_file' });
    } else if (m.role === 'assistant') {
      const msg: OllamaMessage = { role: 'assistant', content: m.content };
      if (m.toolCalls?.length) msg.tool_calls = m.toolCalls;
      out.push(msg);
    } else {
      out.push({ role: 'user', content: m.content });
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

  emit({ chatId, type: 'message', message: db.addMessage({ chatId, role: 'user', content: text, routine: deps.fromRoutine === true }) });

  let partial = '';
  try {
    for (let round = 0; ; round++) {
      partial = '';
      const { content, toolCalls } = await streamChat({
        model: deps.model,
        host: deps.host ?? OLLAMA_HOST,
        fetchImpl: deps.fetchImpl,
        messages: buildHistory({ ...bot, toolsEnabled: toolsOn }, db.listMessages(chatId)),
        tools: toolsOn ? [READ_FILE_TOOL] : undefined,
        signal,
        onToken: (t) => { partial += t; emit({ chatId, type: 'token', text: t }); },
      });
      partial = '';
      const wantsTools = toolsOn && toolCalls.length > 0;
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
        const outcome = await executeToolCall(call, bot.folderPath);
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
