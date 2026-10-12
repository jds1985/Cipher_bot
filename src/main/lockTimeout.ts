// v1.24: lock after a period of no use (Settings: 1, 5 or 15 minutes, or never; default 5). Measured in main with the
// system idle time (Electron powerMonitor, local only). Applies only while the lock is on.
export const LOCK_TIMEOUTS = ['1', '5', '15', 'never'] as const;
export type LockTimeout = (typeof LOCK_TIMEOUTS)[number];
export const LOCK_TIMEOUT_KEY = 'lock_timeout_min';
export const DEFAULT_LOCK_TIMEOUT: LockTimeout = '5';
export const IDLE_CHECK_MS = 15_000;

export const parseLockTimeout = (v: unknown): LockTimeout =>
  (LOCK_TIMEOUTS as readonly unknown[]).includes(v) ? (v as LockTimeout) : DEFAULT_LOCK_TIMEOUT;

/** True when the app should lock now: lock on, not already locked, timeout set and idle that long. */
export function shouldIdleLock(o: { enabled: boolean; locked: boolean; timeout: LockTimeout; idleSeconds: number }): boolean {
  if (!o.enabled || o.locked || o.timeout === 'never') return false;
  return o.idleSeconds >= Number(o.timeout) * 60;
}
