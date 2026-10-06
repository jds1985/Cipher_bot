import type { OllamaStatus, ToolCall } from '../shared/types';

/** The only network endpoint the app ever talks to: a local Ollama on this computer. */
export const OLLAMA_HOST = 'http://127.0.0.1:11434';
/**
 * The one model Cipher uses (Q4 by default in Ollama; Apache 2.0 licensed). Not bundled: it is downloaded
 * through the local engine on first launch. (qwen2.5:3b is deliberately not used: its license is non-commercial.)
 */
export const DEFAULT_MODEL = 'qwen2.5:7b';
/** Where users can get the engine. Only ever opened in the system browser on an explicit click. */
export const ENGINE_DOWNLOAD_URL = 'https://ollama.com/download';
/** How long Ollama keeps the model in memory after a request, so the next message starts fast. */
export const KEEP_ALIVE = '30m';

/** Model to use: the default, unless the developer-only CIPHER_MODEL env override is set. Never shown on screen. */
export function configuredModel(): string {
  return process.env.CIPHER_MODEL?.trim() || DEFAULT_MODEL;
}

// User-facing messages. Plain language: no engine or model names, always with a step the user can take.
export const ENGINE_MISSING_MESSAGE = "Cipher's model engine isn't running. Install it from the setup page, then reopen Cipher.";
export const MODEL_MISSING_MESSAGE = "Your Cipher bot isn't set up yet. Choose \"Set up again\" to finish setup.";
export const BAD_STREAM_MESSAGE =
  'Cipher received a garbled reply. Please try again; if it keeps happening, restart your computer and reopen Cipher.';
export const CONNECTION_LOST_MESSAGE =
  "Cipher lost its connection to the model engine. Please try again; if it keeps happening, restart your computer and reopen Cipher.";

/** An error whose message is already plain, user-facing wording. */
export class FriendlyError extends Error {}

/** Re-throw friendly errors and aborts as-is; replace anything else (raw network errors) with plain wording. */
function plainStreamError(e: unknown, signal: AbortSignal | undefined): unknown {
  if (signal?.aborted || e instanceof FriendlyError) return e;
  console.error('[cipher] stream error:', e);
  return new FriendlyError(CONNECTION_LOST_MESSAGE);
}

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_name?: string;
}

type FetchFn = typeof fetch;

const withTag = (name: string): string => (name.includes(':') ? name : `${name}:latest`);

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
    return { ...base, running: false, modelPresent: false, problem: ENGINE_MISSING_MESSAGE, action: 'get-engine' };
  }
  const wanted = withTag(model);
  const present = names.some((n) => withTag(n) === wanted);
  if (!present) {
    return { ...base, running: true, modelPresent: false, problem: MODEL_MISSING_MESSAGE, action: 'setup' };
  }
  return { ...base, running: true, modelPresent: true, problem: null, action: null };
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

/** Turn an engine HTTP error into a plain message a user can act on (raw details go to the log only). */
function friendlyError(status: number, raw: string, _model: string): string {
  let msg = raw;
  try { msg = (JSON.parse(raw) as { error?: string }).error ?? raw; } catch { /* plain text */ }
  console.error(`[cipher] engine error ${status}: ${msg}`);
  if (/does not support tools/i.test(msg)) {
    return 'This Cipher bot can\'t read files with the current setup. Turn off file reading for this Cipher bot and try again.';
  }
  if (status === 404 && /not found/i.test(msg)) return MODEL_MISSING_MESSAGE;
  return 'Something went wrong while your Cipher bot was replying. Please try again; if it keeps happening, restart your computer and reopen Cipher.';
}

/** Parse one NDJSON line from Ollama, turning malformed data into a clear user-facing error. */
export function parseStreamLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    throw new FriendlyError(BAD_STREAM_MESSAGE);
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
    throw new FriendlyError(ENGINE_MISSING_MESSAGE);
  }
  if (!res.ok || !res.body) {
    throw new FriendlyError(friendlyError(res.status, await res.text().catch(() => ''), opts.model));
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
    if (chunk.error) throw new FriendlyError(friendlyError(500, JSON.stringify({ error: chunk.error }), opts.model));
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
  } catch (e) {
    throw plainStreamError(e, opts.signal);
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
      if (chunk.error) throw new FriendlyError(friendlyPullError(chunk.error));
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
  console.error(`[cipher] setup download error: ${raw}`);
  if (/dial tcp|no such host|lookup|network is unreachable|timeout|connection refused|i\/o timeout|tls/i.test(raw)) {
    return 'Setup couldn\'t download what your Cipher bot needs. Check your internet connection, then choose "Try again".';
  }
  if (/no space|disk/i.test(raw)) {
    return 'Setup stopped because this computer is out of disk space. Free up about 5 GB, then choose "Try again".';
  }
  return 'Setup stopped before it finished. Choose "Try again"; if it keeps failing, restart your computer and reopen Cipher.';
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
    throw new FriendlyError(ENGINE_MISSING_MESSAGE);
  }
  if (!res.ok || !res.body) {
    const raw = await res.text().catch(() => '');
    let msg = raw;
    try { msg = (JSON.parse(raw) as { error?: string }).error ?? raw; } catch { /* plain text */ }
    throw new FriendlyError(friendlyPullError(msg || `HTTP ${res.status}`));
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
  } catch (e) {
    throw plainStreamError(e, opts.signal);
  } finally {
    reader.releaseLock();
  }
  const final = tracker.snapshot();
  if (!final.done) throw new FriendlyError('Setup stopped before it finished. Choose "Try again".');
  return final;
}
