// Test helpers: a fake cipher-serve speaking the OpenAI chat-completions SSE format, and a test model profile.
import type { ModelProfile } from '../main/chatEngine';
import type { BackendEndpoint } from '../main/backend';

/** A tool-capable test profile (the real 135M manifest has toolCalling: false), so the tool loop stays covered. */
export const TEST_MODEL: ModelProfile = {
  id: 'cipher-test', nCtx: 32768, maxReplyTokens: 300, systemPrompt: 'You are Cipher, a helpful AI assistant.',
  sampling: { temperature: 0.7, topP: 0.9, repetitionPenalty: 1.2 }, capabilities: { toolCalling: true },
};
export const NO_TOOLS_MODEL: ModelProfile = { ...TEST_MODEL, id: 'cipher-135m-test', nCtx: 1024, capabilities: { toolCalling: false } };

export const endpointFor = (baseUrl = 'http://127.0.0.1:9'): BackendEndpoint => ({ baseUrl, token: 'test-token' });
/** EngineDeps fields for a fake server at `baseUrl` (or a fetchImpl-only test). */
export const modelDeps = (baseUrl?: string, model: ModelProfile = TEST_MODEL) => ({ model, endpoint: () => endpointFor(baseUrl) });

export interface FakeMsg { content?: string; tool_calls?: readonly unknown[] }
/** One SSE chunk carrying a content delta and/or tool calls. */
export function sseChunk(m: FakeMsg): string {
  const delta: Record<string, unknown> = {};
  if (m.content) delta.content = m.content;
  if (m.tool_calls?.length) delta.tool_calls = (m.tool_calls as { function: { name: string; arguments: unknown } }[]).map((c, index) => ({ index, function: { name: c.function.name, arguments: typeof c.function.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function.arguments) } }));
  return `data: ${JSON.stringify({ object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
}
export const sseDone = (finish = 'stop'): string =>
  `data: ${JSON.stringify({ object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`;
/** A full SSE body: the chunks, then finish + [DONE]. */
export const sseBody = (...msgs: FakeMsg[]): string => msgs.map(sseChunk).join('') + sseDone();
/** A fetch Response with an SSE body (for fetchImpl fakes). */
export const sseResponse = (...msgs: FakeMsg[]): Response =>
  new Response(sseBody(...msgs), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
export const CHAT_PATH = '/v1/chat/completions';
