import type { OllamaStatus, ToolCall } from '../shared/types';

/** The only network endpoint the app ever talks to: a local Ollama on this computer. */
export const OLLAMA_HOST = 'http://127.0.0.1:11434';
/** Default model (Q4 quantization by default in Ollama). The user downloads it with `ollama pull`. */
export const DEFAULT_MODEL = 'qwen2.5:7b';
/** How long Ollama keeps the model in memory after a request, so the next message starts fast. */
export const KEEP_ALIVE = '30m';

export function configuredModel(): string {
  return process.env.CIPHER_MODEL?.trim() || DEFAULT_MODEL;
}

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_name?: string;
}

type FetchFn = typeof fetch;

const withTag = (name: string): string => (name.includes(':') ? name : `${name}:latest`);

export const pullCommand = (model: string): string => `ollama pull ${model}`;

/** Check whether Ollama is reachable and the model is downloaded. Never throws. */
export async function getStatus(model: string, host = OLLAMA_HOST, fetchImpl: FetchFn = fetch): Promise<OllamaStatus> {
  const base = { model, host };
  let names: string[];
  try {
    const res = await fetchImpl(`${host}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { models?: { name?: string; model?: string }[] };
    names = (body.models ?? []).flatMap((m) => [m.name, m.model]).filter((n): n is string => !!n);
  } catch {
    return {
      ...base, running: false, modelPresent: false,
      problem: `Ollama is not running at ${host}. Install it from https://ollama.com/download, then start it.`,
      fixCommand: 'ollama serve',
    };
  }
  const wanted = withTag(model);
  const present = names.some((n) => withTag(n) === wanted);
  if (!present) {
    return {
      ...base, running: true, modelPresent: false,
      problem: `The model "${model}" is not downloaded yet.`,
      fixCommand: pullCommand(model),
    };
  }
  return { ...base, running: true, modelPresent: true, problem: null, fixCommand: null };
}

export interface StreamChatOptions {
  model: string;
  messages: OllamaMessage[];
  tools?: readonly unknown[];
  signal?: AbortSignal;
  onToken: (text: string) => void;
  host?: string;
  fetchImpl?: FetchFn;
}

export interface StreamChatResult {
  content: string;
  toolCalls: ToolCall[];
}

/** Turn an Ollama HTTP error into a message a user can act on. */
function friendlyError(status: number, raw: string, model: string): string {
  let msg = raw;
  try { msg = (JSON.parse(raw) as { error?: string }).error ?? raw; } catch { /* plain text */ }
  if (/does not support tools/i.test(msg)) {
    return `The model "${model}" does not support tool calling. Turn tools off for this bot, or use a model that supports tools (e.g. qwen2.5:7b or llama3.1:8b).`;
  }
  if (status === 404 && /not found/i.test(msg)) {
    return `The model "${model}" is not downloaded yet. Run: ${pullCommand(model)}`;
  }
  return `Ollama error (${status}): ${msg || 'unknown error'}`;
}

export const BAD_STREAM_MESSAGE =
  'Ollama sent a reply Cipher could not read (malformed stream data). Please try again; if it keeps happening, restart Ollama.';

/** Parse one NDJSON line from Ollama, turning malformed data into a clear user-facing error. */
export function parseStreamLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(BAD_STREAM_MESSAGE);
  }
}

/** POST /api/chat with streaming; calls onToken for each content chunk. Returns full content and any tool calls. */
export async function streamChat(opts: StreamChatOptions): Promise<StreamChatResult> {
  const host = opts.host ?? OLLAMA_HOST;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const body: Record<string, unknown> = { model: opts.model, messages: opts.messages, stream: true, keep_alive: KEEP_ALIVE };
  if (opts.tools && opts.tools.length) body.tools = opts.tools;

  let res: Response;
  try {
    res = await fetchImpl(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    throw new Error(`Could not reach Ollama at ${host}. Is it running? Start it with: ollama serve`);
  }
  if (!res.ok || !res.body) {
    throw new Error(friendlyError(res.status, await res.text().catch(() => ''), opts.model));
  }

  let content = '';
  const toolCalls: ToolCall[] = [];
  const decoder = new TextDecoder();
  let buffered = '';
  const handleLine = (line: string): boolean => {
    if (!line.trim()) return false;
    const chunk = parseStreamLine(line) as {
      error?: string; done?: boolean;
      message?: { content?: string; tool_calls?: ToolCall[] };
    };
    if (chunk.error) throw new Error(friendlyError(500, JSON.stringify({ error: chunk.error }), opts.model));
    const text = chunk.message?.content;
    if (text) { content += text; opts.onToken(text); }
    if (chunk.message?.tool_calls?.length) toolCalls.push(...chunk.message.tool_calls);
    return chunk.done === true;
  };

  const reader = res.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, nl);
        buffered = buffered.slice(nl + 1);
        if (handleLine(line)) return { content, toolCalls };
      }
    }
    buffered += decoder.decode();
    handleLine(buffered);
  } finally {
    reader.releaseLock();
  }
  return { content, toolCalls };
}

