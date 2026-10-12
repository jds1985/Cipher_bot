// v1.20: the update check. Main only, only while Online is on, at most once per 24 hours (last check time saved).
// GET https://api.github.com/repos/jds1985/Cipher_bot/releases/latest. If a newer version exists, the user is asked;
// only then is that release's .deb downloaded (github.com → GitHub's release download host, no other host), its size
// and (if GitHub lists one) SHA-256 digest verified, and saved to Downloads. Nothing is ever installed automatically.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assertUpdateUrlAllowed, UPDATE_API_URL } from './networkGuard';

export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const UPDATE_LAST_CHECK_KEY = 'update_last_check';
export const MAX_DEB_BYTES = 400 * 1024 * 1024;
export const UPDATE_TIMEOUT_MS = 20_000;
const UA = 'CipherBot-update-check';
export const ASSET_NAME_RE = /^cipher_(\d+\.\d+\.\d+)_amd64\.deb$/;

export interface UpdateInfo { version: string; tag: string; url: string; size: number; name: string; sha256: string | null; pageUrl: string }

/** "v1.19" / "1.19.0" → [1, 19, 0]; null if not a version. */
export function parseVersion(v: unknown): [number, number, number] | null {
  if (typeof v !== 'string') return null;
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}
export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate); const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** True when a check is due: never checked, or the last one was 24 h ago or more (or the clock went back). */
export function isCheckDue(lastIso: string | null, now: number): boolean {
  if (!lastIso) return true;
  const t = Date.parse(lastIso);
  return !Number.isFinite(t) || now - t >= CHECK_INTERVAL_MS || t > now + 60_000;
}

/** Pick the .deb from the release JSON. Only an asset of this repo's release, served from github.com, is accepted. */
export function pickDeb(release: unknown): UpdateInfo | null {
  const r = release as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown };
  if (!r || r.draft === true || r.prerelease === true || typeof r.tag_name !== 'string' || !Array.isArray(r.assets)) return null;
  for (const a of r.assets as { name?: unknown; browser_download_url?: unknown; size?: unknown; digest?: unknown }[]) {
    const m = typeof a.name === 'string' ? ASSET_NAME_RE.exec(a.name) : null;
    if (!m || typeof a.browser_download_url !== 'string' || typeof a.size !== 'number' || a.size <= 0 || a.size > MAX_DEB_BYTES) continue;
    const expected = `https://github.com/jds1985/Cipher_bot/releases/download/${encodeURIComponent(r.tag_name)}/${a.name}`;
    if (a.browser_download_url !== expected) continue;
    const sha = typeof a.digest === 'string' && /^sha256:[0-9a-f]{64}$/i.test(a.digest) ? a.digest.slice(7).toLowerCase() : null;
    return { version: m[1], tag: r.tag_name, url: expected, size: a.size, name: a.name as string, sha256: sha,
      pageUrl: `https://github.com/jds1985/Cipher_bot/releases/tag/${encodeURIComponent(r.tag_name)}` };
  }
  return null;
}

export interface NetDeps {
  /** Read live: checked right before each request and each redirect hop. */
  isOnline: () => boolean;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/** GET the latest release. Returns the update if it is newer than `current`, else null. */
export async function checkForUpdate(current: string, deps: NetDeps): Promise<UpdateInfo | null> {
  assertUpdateUrlAllowed(deps.isOnline(), UPDATE_API_URL, 'api');
  const signal = deps.signal ? AbortSignal.any([deps.signal, AbortSignal.timeout(UPDATE_TIMEOUT_MS)]) : AbortSignal.timeout(UPDATE_TIMEOUT_MS);
  const res = await (deps.fetchImpl ?? fetch)(UPDATE_API_URL, {
    method: 'GET', redirect: 'manual', credentials: 'omit', signal,
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': UA, 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (!deps.isOnline()) throw new Error('Online is off.');
  if (res.status !== 200) throw new Error(`GitHub answered ${res.status}.`);
  const text = await res.text();
  if (text.length > 2_000_000) throw new Error('The release information is too large.');
  const info = pickDeb(JSON.parse(text));
  return info && isNewer(info.version, current) ? info : null;
}

/** A file name in `dir` that does not exist yet (name, name (1), ...). */
export function freeName(dir: string, name: string): string {
  const ext = path.extname(name); const stem = name.slice(0, -ext.length);
  for (let i = 0; ; i++) {
    const p = path.join(dir, i ? `${stem} (${i})${ext}` : name);
    if (!fs.existsSync(p)) return p;
  }
}

/**
 * Download the confirmed update's .deb into `dir`. Follows at most 5 redirects, each re-checked (github.com, then
 * GitHub's release download host only). Verifies the size and, when known, the SHA-256. A partial file is removed.
 */
export async function downloadUpdate(info: UpdateInfo, dir: string, deps: NetDeps & { onProgress?: (done: number, total: number) => void }): Promise<string> {
  if (!pickDeb({ tag_name: info.tag, assets: [{ name: info.name, browser_download_url: info.url, size: info.size, digest: info.sha256 ? `sha256:${info.sha256}` : undefined }] })) {
    throw new Error('That is not a Cipher Bot release file.');
  }
  const signal = deps.signal ?? new AbortController().signal;
  let url = info.url;
  let res: Response | null = null;
  for (let hop = 0; hop <= 5; hop++) {
    assertUpdateUrlAllowed(deps.isOnline(), url, hop === 0 ? 'release' : 'asset');
    res = await (deps.fetchImpl ?? fetch)(url, { method: 'GET', redirect: 'manual', credentials: 'omit', signal, headers: { 'User-Agent': UA, Accept: 'application/octet-stream' } });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error('The download redirected nowhere.');
      url = new URL(loc, url).toString();
      continue;
    }
    break;
  }
  if (!res || res.status !== 200 || !res.body) throw new Error(`The download failed (${res?.status ?? 'no answer'}).`);
  const target = freeName(dir, info.name);
  const part = `${target}.part`;
  const hash = crypto.createHash('sha256');
  const out = await fs.promises.open(part, 'wx'); // fails if it exists; never overwrites
  let done = 0;
  let closed = false;
  try {
    const reader = res.body.getReader();
    for (;;) {
      if (!deps.isOnline()) throw new Error('Online was turned off; the download was stopped.');
      const { done: end, value } = await reader.read();
      if (end) break;
      done += value.length;
      if (done > info.size || done > MAX_DEB_BYTES) throw new Error('The download is larger than expected; stopped.');
      hash.update(value);
      await out.write(value);
      deps.onProgress?.(done, info.size);
    }
    await out.close();
    closed = true;
    if (done !== info.size) throw new Error('The download is incomplete.');
    if (info.sha256 && hash.digest('hex') !== info.sha256) throw new Error('The download does not match GitHub\'s checksum.');
    if (fs.existsSync(target)) throw new Error('A file with that name appeared in Downloads; not overwritten.');
    fs.renameSync(part, target);
    return target;
  } catch (e) {
    if (!closed) await out.close().catch(() => undefined);
    fs.rmSync(part, { force: true });
    throw e;
  }
}
