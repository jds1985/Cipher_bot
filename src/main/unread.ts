// v1.16: unread dots. A reply that finishes in a bot's chat or a room the user isn't looking at marks it unread.
// Stored locally in cipher.db (bots.unread, rooms.unread). Never sent to the phone, never shown while locked.

/** Where the window is: whether it's visible and unlocked, and which bot chat or room it shows (null for neither). */
export interface ViewState {
  visible: boolean;
  locked: boolean;
  openBotId: number | null;
  openRoomId: number | null;
}

/** True when a finished reply in this bot or room should leave an unread dot. Stopped turns never do. */
export function shouldMarkUnread(target: { kind: 'bot' | 'room'; id: number }, view: ViewState, aborted: boolean): boolean {
  if (aborted) return false;
  if (!view.visible || view.locked) return true;
  return target.kind === 'bot' ? view.openBotId !== target.id : view.openRoomId !== target.id;
}

/** Settings key for the optional send sound. Absent means off. */
export const SEND_SOUND_SETTING_KEY = 'send_sound';
export const parseSendSound = (v: string | null): boolean => v === '1';
