import type { BackendStatus, ToolCall } from '../shared/types';

/**
 * The chat backend. Cipher Bot runs ONLY on Jim's own Cipher model, served by the bundled cipher-serve on 127.0.0.1
 * (OpenAI-compatible /v1/chat/completions with SSE streaming). There is no third-party model and no fallback.
 */
export interface BackendEndpoint {
  /** e.g. http://127.0.0.1:43117 (loopback only). */
  baseUrl: string;
  /** Per-launch random bearer token; cipher-serve refuses requests without it. */
  token: string;
}

export const SERVER_NOT_READY_MESSAGE = 'The Cipher model is still starting. Please wait a moment and try again.';
export const SERVER_DOWN_MESSAGE = "Cipher's model stopped unexpectedly. Choose \"Try again\"; if it keeps happening, reopen Cipher Bot.";
export const BAD_STREAM_MESSAGE = 'Cipher Bot received a garbled reply. Please try again.';
export const CONNECTION_LOST_MESSAGE = "Cipher Bot lost its connection to Cipher's model. Please try again.";

/** An error whose message is already plain, user-facing wording. */
export class FriendlyError extends Error {}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Sent only with `tools` (tool-capable models); the 135M stand-in gets neither. */
  tool_calls?: ToolCall[];
  tool_name?: string;
}

export interface StreamChatOptions {
  endpoint: BackendEndpoint | null;
  messages: ChatMessage[];
  /** OpenAI-style tool definitions. Only passed for models whose manifest sets capabilities.toolCalling. */
  tools?: readonly unknown[];
  maxTokens?: number;
  sampling?: { temperature: number; topP: number; repetitionPenalty: number };
  signal?: AbortSignal;
  onToken: (text: string) => void;
  fetchImpl?: typeof fetch;
}

export interface StreamStats {
  promptTokens: number;
  completionTokens: number;
  ttftMs: number;
  genTokS: number;
  droppedMessages: number;
}

export interface StreamChatResult {
  content: string;
  /** Tool calls the model made (OpenAI streaming delta.tool_calls, merged by index). Never any without `tools`. */
  toolCalls: ToolCall[];
  finishReason: string | null;
  stats: StreamStats | null;
}

/** Parse one SSE data payload; malformed data is a friendly error. */
export function parseSseData(data: string): unknown {
  try { return JSON.parse(data); } catch { throw new FriendlyError(BAD_STREAM_MESSAGE); }
}

/** What goes on the wire. Without tools, tool turns are plain text (cipher-serve renders role "tool" as "Tool result: ..."). */
const wire = (m: ChatMessage, withTools: boolean): Record<string, unknown> =>
  withTools && m.tool_calls?.length ? { role: m.role, content: m.content, tool_calls: m.tool_calls }
    : withTools && m.role === 'tool' ? { role: 'tool', content: m.content, name: m.tool_name }
      : { role: m.role, content: m.content };

export async function streamChat(opts: StreamChatOptions): Promise<StreamChatResult> {
  if (!opts.endpoint) throw new FriendlyError(SERVER_NOT_READY_MESSAGE);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const s = opts.sampling;
  const withTools = !!opts.tools?.length;
  const body = {
    model: 'cipher', stream: true, messages: opts.messages.map((m) => wire(m, withTools)),
    ...(withTools ? { tools: opts.tools } : {}),
    ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
    ...(s ? { temperature: s.temperature, top_p: s.topP, repetition_penalty: s.repetitionPenalty } : {}),
  };
  let res: Response;
  try {
    res = await fetchImpl(`${opts.endpoint.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.endpoint.token}` },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    throw new FriendlyError(SERVER_DOWN_MESSAGE);
  }
  if (!res.ok || !res.body) {
    const raw = await res.text().catch(() => '');
    console.error(`[cipher] model server error ${res.status}: ${raw.slice(0, 300)}`);
    throw new FriendlyError('Something went wrong while your Cipher bot was replying. Please try again.');
  }
  let content = '';
  let finishReason: string | null = null;
  let stats: StreamStats | null = null;
  const calls: { name: string; args: string; obj: unknown }[] = [];
  const decoder = new TextDecoder();
  let buf = '';
  const reader = res.body.getReader();
  const onEvent = (evt: string): boolean => {
    for (const line of evt.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return true;
      const chunk = parseSseData(data) as {
        error?: { message?: string };
        choices?: { delta?: { content?: string; tool_calls?: { index?: number; function?: { name?: string; arguments?: unknown } }[] }; finish_reason?: string | null }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        cipher?: { ttft_ms?: number; gen_tok_s?: number; dropped_messages?: number };
      };
      if (chunk.error) throw new FriendlyError('Something went wrong while your Cipher bot was replying. Please try again.');
      const c = chunk.choices?.[0];
      const text = c?.delta?.content;
      if (text) { content += text; opts.onToken(text); }
      for (const tc of c?.delta?.tool_calls ?? []) {
        const i = typeof tc.index === 'number' ? tc.index : calls.length;
        const slot = (calls[i] ??= { name: '', args: '', obj: null });
        if (tc.function?.name) slot.name += tc.function.name;
        const a = tc.function?.arguments;
        if (typeof a === 'string') slot.args += a; else if (a && typeof a === 'object') slot.obj = a;
      }
      if (c?.finish_reason) finishReason = c.finish_reason;
      if (chunk.usage) {
        stats = {
          promptTokens: chunk.usage.prompt_tokens ?? 0, completionTokens: chunk.usage.completion_tokens ?? 0,
          ttftMs: chunk.cipher?.ttft_ms ?? 0, genTokS: chunk.cipher?.gen_tok_s ?? 0, droppedMessages: chunk.cipher?.dropped_messages ?? 0,
        };
      }
    }
    return false;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const evt = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (onEvent(evt)) return { content, toolCalls: toolCallsOf(calls), finishReason, stats };
      }
    }
    buf += decoder.decode();
    if (buf.trim()) onEvent(buf);
  } catch (e) {
    if (opts.signal?.aborted || e instanceof FriendlyError) throw e;
    console.error('[cipher] stream error:', e);
    throw new FriendlyError(CONNECTION_LOST_MESSAGE);
  } finally {
    reader.releaseLock();
  }
  return { content, toolCalls: toolCallsOf(calls), finishReason, stats };
}

function toolCallsOf(calls: { name: string; args: string; obj: unknown }[]): ToolCall[] {
  return calls.filter(Boolean).map((c) => {
    let args: unknown = c.obj ?? {};
    if (!c.obj && c.args) { try { args = JSON.parse(c.args); } catch { args = c.args; } }
    return { function: { name: c.name, arguments: args } } as ToolCall;
  });
}

/** GET /health. Never throws. */
export async function getStatus(endpoint: BackendEndpoint | null, fetchImpl: typeof fetch = fetch): Promise<BackendStatus> {
  if (!endpoint) return { running: false, model: null, nCtx: null, problem: SERVER_NOT_READY_MESSAGE };
  try {
    const res = await fetchImpl(`${endpoint.baseUrl}/health`, { headers: { Authorization: `Bearer ${endpoint.token}` }, signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const b = (await res.json()) as { status?: string; model?: string; n_ctx?: number };
    if (b.status !== 'ok') throw new Error('not ok');
    return { running: true, model: b.model ?? null, nCtx: b.n_ctx ?? null, problem: null };
  } catch {
    return { running: false, model: null, nCtx: null, problem: SERVER_DOWN_MESSAGE };
  }
}
