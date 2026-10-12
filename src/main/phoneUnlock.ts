// v1.24: the phone asks for the passphrase too while the lock is on. The phone link is plain HTTP, so the passphrase
// is NEVER sent: main issues a one-time challenge (random nonce + the scrypt salt and cost of lock.json), the phone
// derives the scrypt key itself (src/phone/kdf.js) and answers HMAC-SHA256(key, "cipher-phone-unlock-v1|" + nonce).
// Main recomputes that from lock.json's stored hash, here, and compares in constant time. The stored hash, lock.json
// and the passphrase never go over the link. Challenges are one-time and expire in 60 s; wrong answers back off
// (same throttle as the desktop: 5 free tries, then 30 s doubling); an unlock lasts 10 minutes of that session and is
// voided whenever the desktop locks or Phone link stops.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AttemptThrottle, type LockRecord } from './lock';

export const PHONE_CHALLENGE_TTL_MS = 60_000;
export const PHONE_UNLOCK_TTL_MS = 10 * 60_000;
export const PHONE_UNLOCK_CONTEXT = 'cipher-phone-unlock-v1|';

/** The expected answer for a nonce, from the stored scrypt hash (main only). */
export function expectedResponse(rec: Pick<LockRecord, 'hash'>, nonceHex: string): Buffer {
  return createHmac('sha256', Buffer.from(rec.hash, 'base64')).update(PHONE_UNLOCK_CONTEXT + nonceHex).digest();
}

export interface PhoneChallenge { nonce: string; salt: string; N: number; r: number; p: number; keylen: number }

export class PhoneUnlock {
  private challenges = new Map<string, { nonce: string; exp: number }>();
  private unlocked = new Map<string, number>();
  private throttle = new AttemptThrottle();

  constructor(private deps: { record: () => LockRecord | 'invalid' | null; now?: () => number }) {}
  private now(): number { return (this.deps.now ?? Date.now)(); }

  /** Lock on? (a lock file exists; an unreadable one fails closed). */
  required(): boolean { return this.deps.record() !== null; }

  isUnlocked(session: string): boolean {
    if (!this.required()) return true;
    const exp = this.unlocked.get(session);
    if (exp !== undefined && exp > this.now()) return true;
    this.unlocked.delete(session);
    return false;
  }

  challenge(session: string): { ok: true; challenge: PhoneChallenge } | { ok: false; error: string; waitMs: number } {
    const wait = this.throttle.waitMs(this.now());
    if (wait > 0) return { ok: false, error: `Too many tries. Wait ${Math.ceil(wait / 1000)} seconds.`, waitMs: wait };
    const rec = this.deps.record();
    if (!rec || rec === 'invalid') return { ok: false, error: 'The lock cannot be checked from the phone.', waitMs: 0 };
    const nonce = randomBytes(32).toString('hex');
    this.challenges.set(session, { nonce, exp: this.now() + PHONE_CHALLENGE_TTL_MS });
    return { ok: true, challenge: { nonce, salt: rec.salt, N: rec.N, r: rec.r, p: rec.p, keylen: rec.keylen } };
  }

  /** Check an answer. The challenge is used up either way. */
  answer(session: string, response: unknown): { ok: true } | { ok: false; error: string; waitMs: number } {
    const wait = this.throttle.waitMs(this.now());
    if (wait > 0) return { ok: false, error: `Too many tries. Wait ${Math.ceil(wait / 1000)} seconds.`, waitMs: wait };
    const ch = this.challenges.get(session);
    this.challenges.delete(session);
    const rec = this.deps.record();
    if (!ch || ch.exp < this.now() || !rec || rec === 'invalid') return { ok: false, error: 'That try expired. Try again.', waitMs: 0 };
    const got = typeof response === 'string' && /^[0-9a-f]{64}$/.test(response) ? Buffer.from(response, 'hex') : Buffer.alloc(0);
    const want = expectedResponse(rec, ch.nonce);
    if (got.length === want.length && timingSafeEqual(got, want)) {
      this.throttle.succeed();
      this.unlocked.set(session, this.now() + PHONE_UNLOCK_TTL_MS);
      return { ok: true };
    }
    const next = this.throttle.fail(this.now());
    return { ok: false, error: next > 0 ? `Wrong passphrase. Wait ${Math.ceil(next / 1000)} seconds.` : 'Wrong passphrase.', waitMs: next };
  }

  /** Desktop locked / Phone link stopped: every phone unlock and open challenge is void. */
  revokeAll(): void { this.challenges.clear(); this.unlocked.clear(); }
}
