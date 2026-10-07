// Pure view decisions for the renderer (no DOM), kept separate so they can be unit-tested.
import type { SetupState } from '../shared/types';

export type MainView = 'form' | 'room-form' | 'settings' | 'policy' | 'setup' | 'chat';

/** Phases in which the "Setting up your Cipher bot" screen covers the chats. */
export const needsSetupScreen = (st: SetupState): boolean =>
  st.phase === 'engine-missing' || st.phase === 'model-missing' || st.phase === 'downloading' || st.phase === 'error';

/**
 * First run (no Cipher bots yet) always starts on "Create a Cipher bot". After that the setup screen
 * covers chats and rooms until the model is ready. Never blocks on 'checking'.
 */
export function decideView(input: { botCount: number; formOpen: boolean; roomFormOpen?: boolean; settingsOpen?: boolean; policyOpen?: boolean; setup: SetupState }): MainView {
  if (input.formOpen || input.botCount === 0) return 'form';
  if (input.roomFormOpen) return 'room-form';
  if (input.policyOpen) return 'policy';
  if (input.settingsOpen) return 'settings';
  return needsSetupScreen(input.setup) ? 'setup' : 'chat';
}

/** Display name of a room: its own name, or its members' names. */
export function roomTitle(name: string, memberNames: readonly string[]): string {
  return name.trim() || memberNames.join(', ') || 'Room';
}

function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  return `${Math.round(n / 1e3)} KB`;
}

export interface SetupCopy {
  text: string;
  detail: string | null;
  showProgress: boolean;
  showGetEngine: boolean;
  /** Label of the retry button, or null to hide it. */
  retryLabel: string | null;
}

/** What the setup screen says and which buttons it shows, per phase. Plain language, always with a next step. */
export function setupCopy(st: SetupState): SetupCopy {
  if (st.phase === 'downloading') {
    return {
      text: 'Cipher is downloading what your Cipher bot needs to think. This happens once and can take a few minutes.',
      detail: st.total > 0 ? `${Math.floor(st.percent ?? 0)}% · ${formatBytes(st.completed)} of ${formatBytes(st.total)}` : 'Starting…',
      showProgress: true,
      showGetEngine: false,
      retryLabel: null,
    };
  }
  const text = st.message ?? 'Checking…';
  if (st.phase === 'engine-missing') return { text, detail: null, showProgress: false, showGetEngine: true, retryLabel: 'Check again' };
  if (st.phase === 'model-missing') return { text, detail: null, showProgress: false, showGetEngine: false, retryLabel: 'Set up again' };
  if (st.phase === 'error') return { text, detail: null, showProgress: false, showGetEngine: false, retryLabel: 'Try again' };
  return { text, detail: null, showProgress: false, showGetEngine: false, retryLabel: null };
}

// ---------- splash (v1.10) ----------
/** The splash shows on every launch for about a second; nothing is stored, so it can't be "already seen". */
export const SPLASH_MIN_MS = 1000;
/** It never stays longer than this, even if loading is slow (the CSS also hides it at 1.75 s as a safety net). */
export const SPLASH_MAX_MS = 1500;

/** Whether this window shows the splash: always, except a window main re-created in the same process (#nosplash). */
export const showsSplash = (hash: string): boolean => hash !== '#nosplash';

/** How much longer to keep the splash once the app has loaded, so it shows for about SPLASH_MIN_MS in total. */
export const splashRemainingMs = (elapsedMs: number): number => Math.max(0, SPLASH_MIN_MS - elapsedMs);

// ---------- plus menu (v1.10) ----------
export type PlusItemId = 'attach' | 'export' | 'clear' | 'edit' | 'folder' | 'tools' | 'routine';

export interface PlusItem {
  id: PlusItemId;
  label: string;
  disabled: boolean;
  /** For the Read files toggle: its on/off state. */
  checked?: boolean;
  /** Small extra text (e.g. the chosen folder). */
  hint?: string;
}

/**
 * The plus menu's items. Rooms get only what rooms had before (Export). A bot's chat gets Attach, Export, Clear,
 * Edit, Choose folder, Read files and Routine, with the same availability as the old header/composer controls:
 * Attach waits while the chat is replying; Choose folder needs Read files on.
 */
export function plusMenuItems(input:
  | { kind: 'room' }
  | { kind: 'bot'; toolsEnabled: boolean; folderPath: string | null; busy: boolean; routineTime: string | null }): PlusItem[] {
  if (input.kind === 'room') return [{ id: 'export', label: 'Export chat…', disabled: false }];
  return [
    { id: 'attach', label: 'Attach file…', disabled: input.busy },
    { id: 'export', label: 'Export chat…', disabled: false },
    { id: 'clear', label: 'Clear chat…', disabled: false },
    { id: 'edit', label: 'Edit bot…', disabled: false },
    { id: 'folder', label: 'Choose folder…', disabled: !input.toolsEnabled, hint: input.toolsEnabled ? (input.folderPath ?? 'No folder chosen') : 'Turn on Read files first' },
    { id: 'tools', label: 'Read files', disabled: false, checked: input.toolsEnabled },
    { id: 'routine', label: input.routineTime ? `Routine (daily ${input.routineTime})…` : 'Routine…', disabled: false },
  ];
}
