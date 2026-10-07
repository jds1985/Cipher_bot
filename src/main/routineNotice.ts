// Routine finished notice (v1.11): a desktop notification when a routine's reply finishes or fails.
// Shown through the operating system's own notification service (Electron's Notification: libnotify/D-Bus on
// Linux, the Notification Center on macOS, toasts on Windows). No network. Privacy: the notice names the bot and
// says finished or failed; it never contains the routine's prompt or the reply, because notifications can show on
// the lock screen and stay in the system's notification history.
// Pure logic with Electron injected (see main.ts), so it can be tested without Electron.

export type RoutineOutcome = 'finished' | 'failed';

/** What happened to a routine turn. A turn stopped on purpose (Stop, or Cipher quitting) gets no notice. */
export function routineOutcome(turn: { aborted: boolean; failed: boolean }): RoutineOutcome | null {
  if (turn.aborted) return null;
  return turn.failed ? 'failed' : 'finished';
}

/** The window as main sees it; null when there is no window at all. */
export interface NoticeWindowState {
  visible: boolean;
  focused: boolean;
  minimized: boolean;
}

/**
 * Show the notice unless the user is already looking at that bot's chat: window shown, focused, not minimized,
 * and that bot's chat open. Hidden in the tray, minimized, unfocused, or another chat/screen open: show it.
 */
export function shouldShowRoutineNotice(win: NoticeWindowState | null, openBotId: number | null, botId: number): boolean {
  if (!win) return true;
  return !(win.visible && win.focused && !win.minimized && openBotId === botId);
}

/** Longest bot name shown in the notice. */
export const NOTICE_NAME_MAX = 60;

/** Title and body: the bot's name and finished/failed only. Never the prompt or the reply. */
export function routineNoticeContent(outcome: RoutineOutcome, botName: string | null): { title: string; body: string } {
  let name = (botName ?? '').replace(/\s+/g, ' ').trim() || 'Cipher bot';
  if (name.length > NOTICE_NAME_MAX) name = `${name.slice(0, NOTICE_NAME_MAX - 1)}…`;
  return { title: 'Cipher', body: `Routine ${outcome === 'failed' ? 'failed' : 'finished'}: ${name}` };
}

/** The part of Electron's Notification used here. */
export interface NotificationLike {
  on(event: 'click' | 'close', listener: () => void): unknown;
  show(): void;
}

export interface RoutineNotifierDeps {
  /** Electron's Notification.isSupported(). When false, nothing is shown. */
  isSupported(): boolean;
  /** new Notification({ title, body, icon }) with the existing app icon. */
  create(opts: { title: string; body: string }): NotificationLike;
  windowState(): NoticeWindowState | null;
  /** The bot whose 1:1 chat the window has open (null for a room, a settings screen, or nothing). */
  openBotId(): number | null;
  botName(botId: number): string | null;
  /** Clicking the notice: show the window and open that bot's chat. */
  openBotChat(botId: number): void;
}

/** Keeps shown notices referenced (so their click still works) until clicked or closed, capped. */
const MAX_LIVE = 20;

export class RoutineNotifier {
  private live = new Set<NotificationLike>();

  constructor(private deps: RoutineNotifierDeps) {}

  /** Show the notice for a routine turn's outcome if appropriate. Returns true if one was shown. Never throws. */
  notify(botId: number, outcome: RoutineOutcome | null): boolean {
    try {
      if (outcome === null) return false;
      if (!this.deps.isSupported()) return false;
      if (!shouldShowRoutineNotice(this.deps.windowState(), this.deps.openBotId(), botId)) return false;
      const n = this.deps.create(routineNoticeContent(outcome, this.deps.botName(botId)));
      const forget = () => { this.live.delete(n); };
      n.on('click', () => { forget(); this.deps.openBotChat(botId); });
      n.on('close', forget);
      if (this.live.size >= MAX_LIVE) this.live.delete(this.live.values().next().value as NotificationLike);
      this.live.add(n);
      n.show();
      return true;
    } catch {
      return false;
    }
  }

  get liveCount(): number {
    return this.live.size;
  }
}
