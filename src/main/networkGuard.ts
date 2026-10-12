/**
 * Online switch (v1.6): default OFF. While OFF, Cipher must not initiate outbound internet.
 * Allowed always: loopback (127.0.0.1 / ::1) — local Ollama and the phone-link LAN server.
 * Also always allowed (user click only): the engine download page (https://ollama.com/download),
 * so a new install can use "Get the engine" without turning Online on first.
 * Phone link is LAN-only; it must never open external URLs or cloud endpoints.
 * v1.18: when Online is ON, the one thing Cipher Bot's own code may request is web search at
 * https://html.duckduckgo.com/html/ (after the user presses Search). Nothing else. No email, no logins.
 */

export const ONLINE_SETTING_KEY = 'online';

/** Persistable default: Online is off until the user turns it on. */
export function parseOnlineSetting(value: string | null | undefined): boolean {
  return value === '1' || value === 'true';
}

export function onlineSettingValue(on: boolean): string {
  return on ? '1' : '0';
}

/** True for loopback / link-local style hosts the app may always talk to. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '0.0.0.0';
}

/** The one user-clicked engine download page allowed even when Online is off. */
export function isEngineDownloadUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname === 'ollama.com' &&
      (parsed.pathname === '/download' || parsed.pathname === '/download/')
    );
  } catch {
    return false;
  }
}

/**
 * Refuse non-loopback URLs while Online is off, except the engine download page
 * (so "Get the engine" works on a new install without turning Online on).
 * Phone-link and other app code must call this before any outbound fetch / openExternal.
 */
export function assertOutboundAllowed(online: boolean, url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid URL.');
  }
  if (isLoopbackHost(parsed.hostname)) return;
  if (isEngineDownloadUrl(url)) return;
  if (!online) {
    throw new Error('Online is off. Cipher stays on this computer and will not open internet addresses.');
  }
}

/** Whether a URL is safe for phone-link code paths (must stay local — never internet). */
export function isPhoneLinkSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

// ---------- v1.18: web search (the only internet request Cipher Bot's code makes, and only while Online is on) ----------

/** The one search endpoint: DuckDuckGo's keyless HTML results page. */
export const SEARCH_URL = 'https://html.duckduckgo.com/html/';

/** True only for exactly https://html.duckduckgo.com/html/ (no other host, port, path or scheme). */
export function isSearchUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'html.duckduckgo.com' && u.port === '' && u.pathname === '/html/' &&
      u.username === '' && u.password === '';
  } catch {
    return false;
  }
}

/**
 * Gate for every search request: refuses while Online is off, and refuses any URL that isn't the search endpoint.
 * webSearch() calls this immediately before sending.
 */
export function assertSearchAllowed(online: boolean, url: string): void {
  if (!online) throw new Error('Online is off, so web search is not available.');
  if (!isSearchUrl(url)) throw new Error('Only web search may go online.');
}

/** A source link the user clicked: http(s) only, and only while Online is on (opens in the system browser). */
export function assertLinkOpenAllowed(online: boolean, url: string): void {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error('Invalid link.'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Only web links can be opened.');
  if (!online) throw new Error('Online is off. Turn it on in Settings to open this link.');
}
