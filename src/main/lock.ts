// App lock (v1.13): a local passphrase, checked only in the main process.
// The passphrase itself is never stored, logged, exported or sent anywhere. Only a salted scrypt hash is kept, in
// its own small file (lock.json in Cipher's user data folder, mode 0600), separate from cipher.db, so it is never
// part of a backup and a restore can't change it. Hashing uses Node's built-in crypto (no new dependencies).
// The lock is NOT encryption: cipher.db stays readable by anyone with access to the user's files.
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const LOCK_FILE_NAME = 'lock.json';
export const MIN_PASSPHRASE = 8;
/** Upper bound so a huge paste can't make scrypt work on megabytes of input. */
export const MAX_PASSPHRASE = 1024;

/** scrypt cost: N=2^15, r=8, p=1 (about 32 MiB of memory); maxmem is raised so Node doesn't refuse it. */
export const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1, keylen: 32 } as const;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const SALT_BYTES = 16;
/** Shortest derived hash accepted (bytes). */
const MIN_KEYLEN = 32;

/** What lock.json holds: the scrypt parameters, the random salt and the derived hash (base64). Never the passphrase. */
export interface LockRecord {
  v: 1;
  kdf: 'scrypt';
  N: number;
  r: number;
  p: number;
  keylen: number;
  salt: string;
  hash: string;
}

function scrypt(passphrase: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(passphrase.normalize('NFC'), salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Plain-language check for a new passphrase (throws). */
export function validateNewPassphrase(passphrase: unknown, confirm: unknown): string {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE) {
    throw new Error(`The passphrase must be at least ${MIN_PASSPHRASE} characters.`);
  }
  if (passphrase.length > MAX_PASSPHRASE) throw new Error(`The passphrase is too long (max ${MAX_PASSPHRASE} characters).`);
  if (passphrase !== confirm) throw new Error('The two passphrases don\'t match.');
  return passphrase;
}

/** Hash a passphrase with a fresh random salt. */
export async function hashPassphrase(passphrase: string): Promise<LockRecord> {
  const salt = randomBytes(SALT_BYTES);
  const { N, r, p, keylen } = SCRYPT_PARAMS;
  const hash = await scrypt(passphrase, salt, keylen, { N, r, p, maxmem: SCRYPT_MAXMEM });
  return { v: 1, kdf: 'scrypt', N, r, p, keylen, salt: salt.toString('base64'), hash: hash.toString('base64') };
}

/** True if the passphrase matches the record (constant-time comparison of the hashes). */
export async function verifyPassphrase(passphrase: unknown, rec: LockRecord): Promise<boolean> {
  if (typeof passphrase !== 'string' || passphrase.length === 0 || passphrase.length > MAX_PASSPHRASE) return false;
  const expected = Buffer.from(rec.hash, 'base64');
  const actual = await scrypt(passphrase, Buffer.from(rec.salt, 'base64'), Math.max(MIN_KEYLEN, rec.keylen), {
    N: rec.N, r: rec.r, p: rec.p, maxmem: SCRYPT_MAXMEM,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const isPow2 = (n: number) => Number.isSafeInteger(n) && n > 1 && (n & (n - 1)) === 0;

/** Parse lock.json; null if it isn't a valid record. */
export function parseLockRecord(text: string): LockRecord | null {
  try {
    const o = JSON.parse(text) as Partial<LockRecord>;
    if (o.v !== 1 || o.kdf !== 'scrypt') return null;
    if (!isPow2(o.N as number) || (o.N as number) > 1 << 20) return null;
    if (!Number.isSafeInteger(o.r) || (o.r as number) < 1 || (o.r as number) > 32) return null;
    if (!Number.isSafeInteger(o.p) || (o.p as number) < 1 || (o.p as number) > 16) return null;
    if (typeof o.salt !== 'string' || typeof o.hash !== 'string') return null;
    if (Buffer.from(o.salt, 'base64').length < SALT_BYTES || Buffer.from(o.hash, 'base64').length < MIN_KEYLEN) return null;
    return { v: 1, kdf: 'scrypt', N: o.N!, r: o.r!, p: o.p!, keylen: Buffer.from(o.hash, 'base64').length, salt: o.salt, hash: o.hash };
  } catch {
    return null;
  }
}

/** The lock file in the user data folder. Written atomically with mode 0600 (owner read/write only). */
export class LockStore {
  readonly file: string;
  constructor(dir: string) {
    this.file = path.join(dir, LOCK_FILE_NAME);
  }

  exists(): boolean {
    return fs.existsSync(this.file);
  }

  /** The record, or null when there is no lock file. A file that exists but can't be read fails closed ('invalid'). */
  read(): LockRecord | null | 'invalid' {
    if (!this.exists()) return null;
    try {
      return parseLockRecord(fs.readFileSync(this.file, 'utf8')) ?? 'invalid';
    } catch {
      return 'invalid';
    }
  }

  write(rec: LockRecord): void {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch { /* not supported on this platform */ }
    fs.renameSync(tmp, this.file);
  }

  remove(): void {
    fs.rmSync(this.file, { force: true });
  }
}

/** Wrong tries before the first wait, and the first wait. Each further 5 wrong tries doubles it (max 10 minutes). */
export const FREE_ATTEMPTS = 5;
export const FIRST_WAIT_MS = 30_000;
const MAX_WAIT_MS = 10 * 60_000;

/** Slows down guessing: after 5 wrong tries in a row, wait 30 s; after 10, 60 s; and so on. In memory only. */
export class AttemptThrottle {
  private failures = 0;
  private until = 0;

  /** Milliseconds left before another try is allowed (0 = allowed now). */
  waitMs(now = Date.now()): number {
    return Math.max(0, this.until - now);
  }

  fail(now = Date.now()): number {
    this.failures++;
    if (this.failures % FREE_ATTEMPTS === 0) {
      const steps = this.failures / FREE_ATTEMPTS - 1;
      this.until = now + Math.min(MAX_WAIT_MS, FIRST_WAIT_MS * 2 ** steps);
    }
    return this.waitMs(now);
  }

  succeed(): void {
    this.failures = 0;
    this.until = 0;
  }
}

export type UnlockResult = { ok: true } | { ok: false; error: string; waitMs: number };

export const LOCKED_MESSAGE = 'Cipher is locked.';

/**
 * The app lock state. Off when there is no lock file. When on, Cipher starts locked, and main locks it again
 * whenever the hidden window is shown. The passphrase passes through unlock()/set/change/disable once and isn't kept.
 */
export class AppLock {
  private locked: boolean;
  private throttle: AttemptThrottle;

  constructor(private store: LockStore, private now: () => number = Date.now) {
    this.locked = this.isEnabled();
    this.throttle = new AttemptThrottle();
  }

  /** On when a lock file exists (even an unreadable one: that fails closed). */
  isEnabled(): boolean {
    return this.store.exists();
  }

  isLocked(): boolean {
    return this.locked;
  }

  state(): { enabled: boolean; locked: boolean } {
    return { enabled: this.isEnabled(), locked: this.locked };
  }

  /** Lock now (no-op when the lock is off). */
  lock(): boolean {
    if (this.isEnabled()) this.locked = true;
    return this.locked;
  }

  private async check(passphrase: unknown): Promise<UnlockResult> {
    const wait = this.throttle.waitMs(this.now());
    if (wait > 0) return { ok: false, error: tooManyMessage(wait), waitMs: wait };
    const rec = this.store.read();
    const ok = rec !== null && rec !== 'invalid' && (await verifyPassphrase(passphrase, rec));
    if (ok) { this.throttle.succeed(); return { ok: true }; }
    const next = this.throttle.fail(this.now());
    return { ok: false, error: next > 0 ? `Wrong passphrase. ${tooManyMessage(next)}` : 'Wrong passphrase.', waitMs: next };
  }

  async unlock(passphrase: unknown): Promise<UnlockResult> {
    if (!this.isEnabled()) { this.locked = false; return { ok: true }; }
    const r = await this.check(passphrase);
    if (r.ok) this.locked = false;
    return r;
  }

  /** Turn the lock on (only while it's off). The app stays unlocked for this session. */
  async enable(passphrase: unknown, confirm: unknown): Promise<void> {
    if (this.isEnabled()) throw new Error('The lock is already on. Use Change passphrase.');
    const p = validateNewPassphrase(passphrase, confirm);
    this.store.write(await hashPassphrase(p));
    this.locked = false;
  }

  async change(current: unknown, passphrase: unknown, confirm: unknown): Promise<UnlockResult> {
    if (!this.isEnabled()) throw new Error('The lock is off.');
    const p = validateNewPassphrase(passphrase, confirm);
    const r = await this.check(current);
    if (!r.ok) return { ...r, error: r.error.replace('Wrong passphrase', 'Wrong current passphrase') };
    this.store.write(await hashPassphrase(p));
    return r;
  }

  async disable(current: unknown): Promise<UnlockResult> {
    if (!this.isEnabled()) { this.locked = false; return { ok: true }; }
    const r = await this.check(current);
    if (!r.ok) return { ...r, error: r.error.replace('Wrong passphrase', 'Wrong current passphrase') };
    this.store.remove();
    this.locked = false;
    return r;
  }
}

function tooManyMessage(waitMs: number): string {
  return `Too many wrong tries. Try again in ${Math.ceil(waitMs / 1000)} s.`;
}

/**
 * IPC channels that work while Cipher is locked. They carry no chat data: the lock itself, setup (model check),
 * and the Online switch's on/off state. Every other handler refuses while locked (see lockGuard).
 */
export const UNLOCKED_CHANNELS: ReadonlySet<string> = new Set([
  'lock:state', 'lock:unlock',
  'setup:get', 'setup:start', 'setup:check', 'engine:openDownloadPage',
  'online:get',
]);

/** Wrap an IPC handler so it refuses while locked, unless its channel is in UNLOCKED_CHANNELS. */
export function lockGuard<A extends unknown[], R>(channel: string, isLocked: () => boolean, fn: (...args: A) => R): (...args: A) => R {
  if (UNLOCKED_CHANNELS.has(channel)) return fn;
  return (...args: A) => {
    if (isLocked()) throw new Error(LOCKED_MESSAGE);
    return fn(...args);
  };
}
