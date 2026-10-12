// v1.18: web search. The ONLY internet request Cipher Bot's own code makes, and only while Online is on and only
// after the user pressed Search on the confirm card. Provider: DuckDuckGo's keyless HTML page
// (https://html.duckduckgo.com/html/) — no account, no API key, no cookies. The query is the only user data sent.
import { SEARCH_URL, assertSearchAllowed } from './networkGuard';

export interface SearchResult { title: string; url: string; snippet: string }

export const MAX_RESULTS = 5;
export const MAX_QUERY_CHARS = 300;
/** Give up on a search that takes longer than this. */
export const SEARCH_TIMEOUT_MS = 15_000;
/** A plain, generic user agent; nothing about the user or this computer. */
export const SEARCH_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) CipherBot';

export class SearchOffError extends Error {
  constructor() { super('Online is off, so web search is not available.'); }
}

/** Check and normalize a model-supplied query: plain text, 1..300 characters, whitespace collapsed. */
export function normalizeQuery(q: unknown): string {
  if (typeof q !== 'string') throw new Error('The search query must be text.');
  const t = q.replace(/\s+/g, ' ').trim();
  if (!t) throw new Error('The search query is empty.');
  if (t.length > MAX_QUERY_CHARS) throw new Error(`The search query is longer than ${MAX_QUERY_CHARS} characters.`);
  return t;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'" };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+[0-9]*);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k in ENTITIES) return ENTITIES[k];
    if (k.startsWith('#x')) { const n = parseInt(k.slice(2), 16); return Number.isFinite(n) && n < 0x110000 ? String.fromCodePoint(n) : m; }
    if (k.startsWith('#')) { const n = parseInt(k.slice(1), 10); return Number.isFinite(n) && n < 0x110000 ? String.fromCodePoint(n) : m; }
    return m;
  });
}
const text = (html: string): string => decodeEntities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

/** DuckDuckGo wraps result links (//duckduckgo.com/l/?uddg=<target>); return the real http(s) target, or null. */
export function realResultUrl(href: string): string | null {
  const raw = decodeEntities(href);
  let u: URL;
  try { u = new URL(raw, 'https://html.duckduckgo.com/'); } catch { return null; }
  if (u.hostname.endsWith('duckduckgo.com')) {
    const target = u.searchParams.get('uddg');
    if (!target) return null; // ads and internal links
    try { u = new URL(target); } catch { return null; }
    if (u.hostname.endsWith('duckduckgo.com')) return null;
  }
  return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
}

/** DuckDuckGo's "anomaly" (bot check) page instead of results. */
export const isChallengePage = (html: string): boolean => !/\bresult__a\b/.test(html) && /anomaly|challenge-form/i.test(html);

/** Parse DuckDuckGo's HTML results page: title, real URL and snippet of the top results (ads skipped). */
export function parseResults(html: string, max = MAX_RESULTS): SearchResult[] {
  const out: SearchResult[] = [];
  const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)];
  for (let i = 0; i < anchors.length && out.length < max; i++) {
    const attrs = anchors[i][1];
    const cls = /class="([^"]*)"/i.exec(attrs)?.[1] ?? '';
    if (!/\bresult__a\b/.test(cls)) continue;
    const url = realResultUrl(/href="([^"]*)"/i.exec(attrs)?.[1] ?? '');
    const title = text(anchors[i][2]);
    if (!url || !title || out.some((r) => r.url === url)) continue;
    let snippet = '';
    for (let j = i + 1; j < anchors.length; j++) {
      const c = /class="([^"]*)"/i.exec(anchors[j][1])?.[1] ?? '';
      if (/\bresult__a\b/.test(c)) break;
      if (/\bresult__snippet\b/.test(c)) { snippet = text(anchors[j][2]); break; }
    }
    out.push({ title: title.slice(0, 200), url, snippet: snippet.slice(0, 400) });
  }
  return out;
}

export interface SearchDeps {
  /** Read live: checked right before sending and again when the answer arrives. */
  isOnline: () => boolean;
  /** Consume the one-time confirmation token for this exact query (see searchConsent.ts). False: send nothing. */
  consumeConsent: (query: string) => boolean;
  /** Called right before the request goes out (main records the last search time; never the query). */
  onSend?: () => void;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * Run one search. Refuses (sends nothing) while Online is off; refuses any URL but the search endpoint; drops the
 * answer if Online was turned off while it was on the way. No cookies, no redirects (any 3xx is refused),
 * a generic user agent, and only with a one-time confirmation token.
 */
export async function webSearch(query: string, deps: SearchDeps): Promise<SearchResult[]> {
  const q = normalizeQuery(query);
  if (!deps.isOnline()) throw new SearchOffError();
  assertSearchAllowed(deps.isOnline(), SEARCH_URL);
  if (!deps.consumeConsent(q)) throw new Error('The search was not confirmed.');
  deps.onSend?.();
  const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
  const signal = deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout;
  const res = await (deps.fetchImpl ?? fetch)(SEARCH_URL, {
    method: 'POST',
    headers: { 'User-Agent': SEARCH_USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' },
    body: new URLSearchParams({ q }).toString(),
    redirect: 'manual', // never follow a redirect (to any host); a 3xx is refused below
    credentials: 'omit',
    signal,
  });
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) throw new Error('The search service tried to redirect; refused.');
  if (res.status !== 200) throw new Error(`DuckDuckGo answered ${res.status}${res.status === 202 ? ' (it may be asking to check you are not a robot; try again later)' : ''}.`);
  const html = (await res.text()).slice(0, 2_000_000);
  if (!deps.isOnline() || deps.signal?.aborted) throw new SearchOffError();
  if (isChallengePage(html)) throw new Error('DuckDuckGo asked to check you are not a robot, so there are no results. Try again later.');
  return parseResults(html);
}

/** The tool result the model reads: numbered titles, links and snippets. */
export function formatResultsForModel(query: string, results: readonly SearchResult[]): string {
  if (!results.length) return `Web search for "${query}" found no results.`;
  return [`Web search results for "${query}":`, ...results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)].join('\n');
}

/** The web_search tool, in Ollama's tools format. Offered only while Online is on, in a bot's 1:1 chat. */
export const WEB_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description:
      'Search the web. The user is shown the exact query and must press Search before anything is sent; ' +
      'if they cancel, you get "User did not confirm the search" and must answer without searching.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'The search words, as short and plain as possible.' } },
      required: ['query'],
    },
  },
} as const;

export const NOT_CONFIRMED_RESULT = 'User did not confirm the search. Do not search; answer without web results and say that no search was made.';
export const OFF_RESULT = 'Online is off, so web search is not available. Answer without web results.';
