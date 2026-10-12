// v1.20: "Export debug log" (Settings). Built on demand from local facts and recent app log lines. By default it holds
// no chat content, memory notes, search words, folder paths, lock data or pairing codes; chat content only if the
// user ticks the box. The passphrase hash and lock.json are never read. Paths, URLs' queries and home dirs are redacted.
import os from 'node:os';

const MAX_LINES = 300;
const ring: string[] = [];

/** Keep the last MAX_LINES log lines (already redacted). */
export function recordLogLine(level: string, args: unknown[]): void {
  const text = args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === 'string' ? a : safeJson(a))).join(' ');
  ring.push(`${new Date().toISOString()} ${level} ${redact(text)}`);
  if (ring.length > MAX_LINES) ring.splice(0, ring.length - MAX_LINES);
}
export const recentLogLines = (): readonly string[] => ring;
export const clearLogLines = (): void => { ring.length = 0; };

function safeJson(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}

/** Redact home directories, absolute paths, URL query strings/fragments, pairing codes and anything token-like. */
export function redact(s: string, home: string = os.homedir()): string {
  let t = s;
  if (home && home.length > 1) t = t.split(home).join('~');
  t = t.replace(/(https?:\/\/[^\s?#"']+)[?#][^\s"']*/gi, '$1?<redacted>');
  t = t.replace(/(^|[\s"'(=:])((?:~|[A-Za-z]:)?[\\/](?:[^\s"'\\/]+[\\/])+[^\s"'\\/]*)/g, (_m, pre: string, p: string) => `${pre}<path:${p.split(/[\\/]/).pop() ? '…/' + p.split(/[\\/]/).pop() : '…'}>`);
  t = t.replace(/\b(q|query|code|token|pairing|passphrase|hash|salt)\s*[=:]\s*("[^"]*"|\S+)/gi, '$1=<redacted>');
  t = t.replace(/\b[A-Fa-f0-9]{32,}\b/g, '<hex>');
  return t;
}

/** Remove quoted text ("…", '…', “…”) from a log line. */
export const stripQuoted = (line: string): string => line.replace(/"[^"]*"|“[^”]*”|'[^'\n]{2,}'/g, '<text>');

export interface DebugFacts {
  appVersion: string; electron: string; chrome: string; node: string; platform: string; arch: string; osRelease: string;
  schemaVersion: number; model: string; online: boolean; locked: boolean; lockEnabled: boolean; phoneRunning: boolean;
  setupPhase: string; counts: Record<string, number>; prefs: Record<string, unknown>; lastUpdateCheck: string | null;
}

/** The log text. `chats` is only passed (and only included) when the user ticked "Include chat content". */
export function buildDebugLog(facts: DebugFacts, lines: readonly string[], chats?: { title: string; messages: { role: string; content: string; createdAt: string }[] }[]): string {
  const out: string[] = [
    'Cipher Bot debug log',
    `Created: ${new Date().toISOString()}`,
    '',
    '## App',
    `Version ${facts.appVersion}; Electron ${facts.electron}; Chrome ${facts.chrome}; Node ${facts.node}`,
    `OS ${facts.platform} ${facts.arch} ${facts.osRelease}`,
    `Database schema ${facts.schemaVersion}; model ${facts.model}; setup ${facts.setupPhase}`,
    `Online ${facts.online ? 'on' : 'off'}; app lock ${facts.lockEnabled ? 'on' : 'off'} (${facts.locked ? 'locked' : 'unlocked'}); Phone link ${facts.phoneRunning ? 'running' : 'off'}`,
    `Last update check: ${facts.lastUpdateCheck ?? 'never'}`,
    `Counts: ${Object.entries(facts.counts).map(([k, v]) => `${k} ${v}`).join(', ')}`,
    `Preferences: ${safeJson(facts.prefs)}`,
    '',
    `## Recent log lines (${lines.length}, redacted)`,
    // Without the box ticked, quoted text in log lines (which could be chat words) is removed too.
    ...(chats ? lines : lines.map(stripQuoted)),
  ];
  if (chats) {
    out.push('', '## Chat content (included because "Include chat content" was ticked)');
    for (const c of chats) {
      out.push('', `### ${c.title}`);
      for (const m of c.messages) out.push(`[${m.createdAt}] ${m.role}: ${m.content}`);
    }
  } else {
    out.push('', 'Chat content: not included.');
  }
  return `${out.join('\n')}\n`;
}
