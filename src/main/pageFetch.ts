// v1.19: open a page from a saved search result as text. Main only. Every hop: http(s) only, Online on, the address
// must resolve to a public IP (checked on the resolved address the socket actually uses), and a redirect is
// re-checked the same way (at most 3). Text/HTML only, size-capped, converted to text here: nothing renders or runs.
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { htmlToText } from './htmlText';

export const PAGE_MAX_BYTES = 1_000_000;
export const PAGE_MAX_TEXT = 40_000;
export const PAGE_TIMEOUT_MS = 15_000;
export const PAGE_MAX_REDIRECTS = 3;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) CipherBot';

/** True for loopback, private (RFC 1918 / ULA), link-local, CGNAT, unspecified, multicast and other non-public addresses. */
export function isBlockedAddress(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return isBlockedAddress(mapped[1]);
    if (s === '::' || s === '::1') return true;
    if (/^f[cd]/.test(s) || /^fe[89ab]/.test(s) || /^ff/.test(s)) return true;
    if (s.startsWith('::ffff:') || s.startsWith('64:ff9b:')) return true;
    // First two 16-bit groups, expanded (handles "2001::", "2001:0:", "2001:0000:").
    const groups = s.split('::')[0].split(':').concat(['0', '0']).slice(0, 2).map((g) => parseInt(g || '0', 16));
    if (groups[0] === 0x2002) return true; // 6to4 (2002::/16): wraps an IPv4 address, may reach a private one
    if (groups[0] === 0x2001 && groups[1] === 0x0000) return true; // Teredo (2001::/32): tunnels to IPv4
    if (groups[0] === 0x2001 && groups[1] === 0x0db8) return true; // documentation
    return false;
  }
  return true;
}

/**
 * Only plain http(s) URLs with no credentials. An IP-literal host is checked here, because Node connects to a literal
 * address without calling the lookup (named hosts are checked by guardedLookup on the resolved address).
 */
export function assertPageUrl(url: string): URL {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error('Invalid link.'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Only web pages (http or https) can be opened.');
  if (u.username || u.password) throw new Error('Links with a user name or password are refused.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && isBlockedAddress(host)) throw new Error('That address is on this computer or a private network; refused.');
  if (/^localhost$|\.localhost$|\.local$/i.test(host)) throw new Error('That address is on this computer or a private network; refused.');
  return u;
}

type LookupFn = (host: string, opts: dns.LookupOptions, cb: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void) => void;

/** A dns lookup that refuses non-public answers, so the checked address is the one connected to (no re-resolve gap). */
export function guardedLookup(base: LookupFn = dns.lookup as unknown as LookupFn): LookupFn {
  return (host, opts, cb) => {
    base(host, { ...opts, all: true }, (err, addrs) => {
      if (err) return cb(err, '', 0);
      const list = (Array.isArray(addrs) ? addrs : [{ address: String(addrs), family: net.isIP(String(addrs)) }]) as dns.LookupAddress[];
      if (!list.length) return cb(Object.assign(new Error('Address not found.'), { code: 'ENOTFOUND' }), '', 0);
      const bad = list.find((a) => isBlockedAddress(a.address));
      if (bad) return cb(Object.assign(new Error('That address is on this computer or a private network; refused.'), { code: 'EBLOCKED' }), '', 0);
      if (opts.all) return cb(null, list);
      cb(null, list[0].address, list[0].family);
    });
  };
}

export interface PageDeps {
  isOnline: () => boolean;
  /** Consume the one-time confirmation token for this exact URL. */
  consumeConsent: (url: string) => boolean;
  signal?: AbortSignal;
  /** Tests: replace the network layer. Must honour opts.lookup. */
  request?: (u: URL, opts: http.RequestOptions) => Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>;
  lookup?: LookupFn;
}

function defaultRequest(u: URL, opts: http.RequestOptions, signal: AbortSignal): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = (u.protocol === 'https:' ? https : http).request(u, { ...opts, signal }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > PAGE_MAX_BYTES) { req.destroy(new Error('The page is larger than 1 MB; refused.')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

export async function fetchPageText(url: string, deps: PageDeps): Promise<{ url: string; title: string; text: string }> {
  let u = assertPageUrl(url);
  if (!deps.isOnline()) throw new Error('Online is off, so pages cannot be opened.');
  if (!deps.consumeConsent(u.toString())) throw new Error('Opening this page was not confirmed.');
  const timeout = AbortSignal.timeout(PAGE_TIMEOUT_MS);
  const signal = deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout;
  const lookup = guardedLookup(deps.lookup);
  for (let hop = 0; ; hop++) {
    if (!deps.isOnline() || signal.aborted) throw new Error('Online is off, so pages cannot be opened.');
    const opts: http.RequestOptions = {
      method: 'GET', lookup: lookup as unknown as http.RequestOptions['lookup'],
      headers: { 'User-Agent': UA, Accept: 'text/html, text/plain;q=0.9' },
    };
    const res = deps.request ? await deps.request(u, opts) : await defaultRequest(u, opts, signal);
    if (!deps.isOnline() || signal.aborted) throw new Error('Online is off, so pages cannot be opened.');
    if (res.status >= 300 && res.status < 400) {
      if (hop >= PAGE_MAX_REDIRECTS) throw new Error('Too many redirects.');
      const loc = res.headers.location;
      if (!loc) throw new Error('The page redirected nowhere.');
      u = assertPageUrl(new URL(loc, u).toString()); // re-checked; the next hop's address is checked by lookup again
      continue;
    }
    if (res.status !== 200) throw new Error(`The site answered ${res.status}.`);
    if (res.body.length > PAGE_MAX_BYTES) throw new Error('The page is larger than 1 MB; refused.');
    const type = String(res.headers['content-type'] ?? '').toLowerCase();
    const isHtml = type.includes('text/html') || type.includes('application/xhtml');
    if (!isHtml && !type.startsWith('text/plain')) throw new Error('That link is not a web page or text (only HTML and plain text are opened).');
    const raw = res.body.toString('utf8');
    const title = isHtml ? htmlToText(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1] ?? '').slice(0, 200) : '';
    let text = isHtml ? htmlToText(raw) : raw.replace(/\r\n?/g, '\n').trim();
    if (text.length > PAGE_MAX_TEXT) text = `${text.slice(0, PAGE_MAX_TEXT)}\n[… page text cut at ${PAGE_MAX_TEXT} characters]`;
    return { url: u.toString(), title, text };
  }
}

export const PAGE_BLOCK_START = '--- Opened page: ';
/** How an opened page sits in the chat (a user message the model reads). */
export function formatPageBlock(p: { url: string; title: string; text: string }): string {
  return `${PAGE_BLOCK_START}${p.url} ---\n${p.title ? `Title: ${p.title}\n\n` : ''}${p.text}\n--- End of page ---`;
}
