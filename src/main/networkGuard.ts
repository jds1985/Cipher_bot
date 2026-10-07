/**
 * Online switch (v1.6): default OFF. While OFF, Cipher must not initiate outbound internet.
 * Allowed always: loopback (127.0.0.1 / ::1) — local Ollama and the phone-link LAN server.
 * Phone link is LAN-only; it must never open external URLs or cloud endpoints.
 * When Online is ON, still no new features in v1.6 — only the existing engine-download
 * page open (user click) is unblocked. Email / search / schedules are not implemented.
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

/**
 * Refuse non-loopback URLs while Online is off.
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
