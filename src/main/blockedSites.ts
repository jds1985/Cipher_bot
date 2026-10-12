// v1.21: the blocked-sites list for search (stored in cipher.db). Pure string/URL checks; no network.

/** v1.21: a blocked-site entry as typed ("example.com", "https://www.example.com/x") → its host, lowercased, no www. */
export function normalizeSite(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let t = input.trim().toLowerCase();
  if (!t) return null;
  if (!/^[a-z]+:\/\//.test(t)) t = `http://${t}`;
  let host: string;
  try { host = new URL(t).hostname; } catch { return null; }
  host = host.replace(/^www\./, '').replace(/\.$/, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || host.length > 253) return null;
  return host;
}

/** True when the URL's host is a blocked site or a subdomain of one. */
export function isUrlBlocked(url: string, sites: readonly string[]): boolean {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase().replace(/\.$/, ''); } catch { return true; }
  return sites.some((s) => host === s || host.endsWith(`.${s}`));
}

