import type { OllamaStatus, ToolCall } from '../shared/types';

/** The only network endpoint the app ever talks to: a local Ollama on this computer. */
export const OLLAMA_HOST = 'http://127.0.0.1:11434';
/** Default model (Q4 quantization by default in Ollama). The user downloads it with `ollama pull`. */
export const DEFAULT_MODEL = 'qwen2.5:7b';
/** The models offered on the Models screen (both Q4 by default in Ollama). */
export const OFFERED_MODELS = [
  { name: 'qwen2.5:3b', label: 'Qwen 2.5 3B', size: 'about 1.9 GB', note: 'Faster, lighter; good for modest computers.' },
  { name: 'qwen2.5:7b', label: 'Qwen 2.5 7B', size: 'about 4.7 GB', note: 'Better answers; needs about 8 GB of RAM.' },
] as const;
/** How long Ollama keeps the model in memory after a request, so the next message starts fast. */
export const KEEP_ALIVE = '30m';

/** Model to use: CIPHER_MODEL env override, else the user's saved choice, else the default. */
export function configuredModel(saved: string | null = null): string {
  return process.env.CIPHER_MODEL?.trim() || saved || DEFAULT_MODEL;
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

// ---------------- model management (v1.1) ----------------

/** Names of models already downloaded in Ollama, or null if Ollama is not reachable. */
export async function listInstalledModels(host = OLLAMA_HOST, fetchImpl: FetchFn = fetch): Promise<string[] | null> {
  try {
    const res = await fetchImpl(`${host}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { models?: { name?: string; model?: string }[] };
    return (body.models ?? []).flatMap((m) => [m.name, m.model]).filter((n): n is string => !!n);
  } catch {
    return null;
  }
}

export const isInstalled = (installed: string[], model: string): boolean =>
  installed.some((n) => withTag(n) === withTag(model));

/** Ask Ollama to load the model into memory now (empty chat request) so the first message is fast. Never throws. */
export async function warmUp(model: string, host = OLLAMA_HOST, fetchImpl: FetchFn = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [], stream: false, keep_alive: KEEP_ALIVE }),
    });
    await res.text().catch(() => '');
    return res.ok;
  } catch {
    return false;
  }
}

export interface PullProgress {
  status: string;
  completed: number;
  total: number;
  /** 0–100, or null while Ollama hasn't reported sizes yet. */
  percent: number | null;
  done: boolean;
}

/**
 * Accumulates /api/pull NDJSON lines into overall progress. Ollama reports each layer (digest) separately,
 * so overall progress is the sum over layers.
 */
export class PullProgressTracker {
  private layers = new Map<string, { completed: number; total: number }>();
  private status = 'starting';
  private done = false;

  /** Feed one raw line. Throws a user-facing Error for malformed lines or Ollama-reported errors. */
  apply(line: string): PullProgress {
    if (line.trim()) {
      const chunk = parseStreamLine(line) as { status?: string; error?: string; digest?: string; total?: number; completed?: number };
      if (chunk.error) throw new Error(friendlyPullError(chunk.error));
      if (chunk.status) this.status = chunk.status;
      if (chunk.digest && typeof chunk.total === 'number' && chunk.total > 0) {
        const prev = this.layers.get(chunk.digest);
        const completed = typeof chunk.completed === 'number' ? chunk.completed : prev?.completed ?? 0;
        this.layers.set(chunk.digest, { total: chunk.total, completed: Math.min(completed, chunk.total) });
      }
      if (chunk.status === 'success') this.done = true;
    }
    return this.snapshot();
  }

  snapshot(): PullProgress {
    let completed = 0;
    let total = 0;
    for (const l of this.layers.values()) { completed += l.completed; total += l.total; }
    const percent = this.done ? 100 : total > 0 ? Math.floor((completed / total) * 1000) / 10 : null;
    return { status: this.status, completed, total, percent, done: this.done };
  }
}

function friendlyPullError(raw: string): string {
  if (/dial tcp|no such host|lookup|network is unreachable|timeout|connection refused/i.test(raw)) {
    return `Download failed: Ollama could not reach the model registry. Check your internet connection and try again. (${raw})`;
  }
  return `Download failed: ${raw}`;
}

export interface PullOptions {
  model: string;
  signal?: AbortSignal;
  onProgress: (p: PullProgress) => void;
  host?: string;
  fetchImpl?: FetchFn;
}

/** POST /api/pull with streaming. Ollama itself does the download; the app only talks to localhost. */
export async function pullModel(opts: PullOptions): Promise<PullProgress> {
  const host = opts.host ?? OLLAMA_HOST;
  const fetchImpl = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(`${host}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: opts.model, stream: true }),
      signal: opts.signal,
    });
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    throw new Error(`Could not reach Ollama at ${host}. Is it running? Start it with: ollama serve`);
  }
  if (!res.ok || !res.body) {
    const raw = await res.text().catch(() => '');
    let msg = raw;
    try { msg = (JSON.parse(raw) as { error?: string }).error ?? raw; } catch { /* plain text */ }
    throw new Error(friendlyPullError(msg || `HTTP ${res.status}`));
  }

  const tracker = new PullProgressTracker();
  const decoder = new TextDecoder();
  let buffered = '';
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
        if (line.trim()) opts.onProgress(tracker.apply(line));
      }
    }
    buffered += decoder.decode();
    if (buffered.trim()) opts.onProgress(tracker.apply(buffered));
  } finally {
    reader.releaseLock();
  }
  const final = tracker.snapshot();
  if (!final.done) throw new Error('Download ended before it finished. Please try again.');
  return final;
}
