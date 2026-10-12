// Pure view decisions for the renderer (no DOM), kept separate so they can be unit-tested.
import type { SetupState } from '../shared/types';

export type MainView = 'form' | 'room-form' | 'settings' | 'policy' | 'about' | 'setup' | 'chat';

/** Phases in which the "Setting up your Cipher bot" screen covers the chats. */
export const needsSetupScreen = (st: SetupState): boolean =>
  st.phase === 'engine-missing' || st.phase === 'model-missing' || st.phase === 'downloading' || st.phase === 'error';

/**
 * First run (no Cipher bots yet) always starts on "Create a Cipher bot". After that the setup screen
 * covers chats and rooms until the model is ready. Never blocks on 'checking'.
 */
export function decideView(input: { botCount: number; formOpen: boolean; roomFormOpen?: boolean; settingsOpen?: boolean; policyOpen?: boolean; aboutOpen?: boolean; setup: SetupState }): MainView {
  if (input.formOpen || input.botCount === 0) return 'form';
  if (input.roomFormOpen) return 'room-form';
  if (input.policyOpen) return 'policy';
  if (input.aboutOpen) return 'about';
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
      text: 'Cipher Bot is downloading what your Cipher bot needs to think. This happens once and can take a few minutes.',
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
export type PlusItemId = 'attach' | 'export' | 'clear' | 'select' | 'edit' | 'folder' | 'second' | 'tools' | 'routine' | 'mute' | 'markdown' | 'archive';

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
 * Attach waits while the chat is replying; Choose folder needs Read files on. v1.15: the second folder item sits next
 * to Choose folder ("Attach second folder…" or "Remove second folder") and also needs Read files on.
 */
export function plusMenuItems(input:
  | { kind: 'room'; muted?: boolean }
  | { kind: 'bot'; toolsEnabled: boolean; folderPath: string | null; secondFolderPath?: string | null; busy: boolean; routineTime: string | null; muted?: boolean }): PlusItem[] {
  // v1.20: Mute (no tray notice for this bot or room while on), last in both menus.
  const mute: PlusItem = { id: 'mute', label: 'Mute notices', disabled: false, checked: input.muted === true };
  const archive: PlusItem = { id: 'archive', label: input.kind === 'room' ? 'Archive room' : 'Archive bot', disabled: input.kind === 'bot' && input.busy };
  if (input.kind === 'room') return [{ id: 'export', label: 'Export chat…', disabled: false }, mute, archive];
  return [
    { id: 'attach', label: 'Attach file…', disabled: input.busy },
    { id: 'export', label: 'Export chat…', disabled: false },
    { id: 'markdown', label: 'Copy chat as Markdown', disabled: false },
    { id: 'clear', label: 'Clear chat…', disabled: false },
    { id: 'select', label: 'Select messages…', disabled: input.busy },
    { id: 'edit', label: 'Edit bot…', disabled: false },
    { id: 'folder', label: 'Choose folder…', disabled: !input.toolsEnabled, hint: input.toolsEnabled ? (input.folderPath ?? 'No folder chosen') : 'Turn on Read files first' },
    {
      id: 'second', label: input.secondFolderPath ? 'Remove second folder' : 'Attach second folder…', disabled: !input.toolsEnabled,
      hint: input.toolsEnabled ? (input.secondFolderPath ?? 'No second folder') : 'Turn on Read files first',
    },
    { id: 'tools', label: 'Read files', disabled: false, checked: input.toolsEnabled },
    { id: 'routine', label: input.routineTime ? `Routine (daily ${input.routineTime})…` : 'Routine…', disabled: false },
    mute,
    archive,
  ];
}

// ---------- message times (v1.17) ----------
/** Local time of a stored message timestamp as h:mm with AM/PM (e.g. "9:05 AM"); '' if the timestamp is unreadable. */
export function formatMessageTime(iso: string, toLocal: (d: Date) => { h: number; m: number } = (d) => ({ h: d.getHours(), m: d.getMinutes() })): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const { h, m } = toLocal(d);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

// ---------- v1.20: starter jobs (local presets for the create form) ----------
export type StarterId = 'writer' | 'researcher' | 'files' | 'blank';
export interface StarterJob { id: StarterId; label: string; name: string; job: string; icon: string }
export const STARTER_JOBS: readonly StarterJob[] = [
  { id: 'writer', label: 'Writer', name: 'Writer', icon: 'assets/cipher-job-writer.svg',
    job: 'Help me write and edit: drafts, emails to copy, posts and summaries. Match my tone, keep it clear and short, and offer one improved version at a time.' },
  { id: 'researcher', label: 'Researcher', name: 'Researcher', icon: 'assets/cipher-job-researcher.svg',
    job: 'Help me research a topic: break the question down, explain the key points, compare options and say what is uncertain. When Online is on you may suggest a web search; cite the links you use.' },
  { id: 'files', label: 'Files', name: 'Files', icon: 'assets/cipher-job-files.svg',
    job: 'Help me with the text files in the folder I share with you: find things, summarize them and answer questions about them. Say which file an answer comes from.' },
  { id: 'blank', label: 'Blank', name: '', icon: 'assets/cipher-job-blank.svg', job: '' },
];

// ---------- v1.20: keyboard shortcuts (shown in Settings) ----------
export const SHORTCUTS: readonly { keys: string; action: string }[] = [
  { keys: 'Enter', action: 'Send the message' },
  { keys: 'Shift+Enter', action: 'New line in the message' },
  { keys: 'Escape', action: 'Close the plus menu, or remove the quote being written' },
  { keys: '↑ / ↓', action: 'Move through the plus menu' },
  { keys: 'Ctrl+Q', action: 'Quit Cipher Bot' },
];

// ---------- v1.21: first-run tips (Liz's cards, in this order; shown once) ----------
export const TIPS: readonly { icon: string; title: string; body: string }[] = [
  { icon: 'assets/cipher-tip-1-welcome.svg', title: 'Welcome to Cipher Bot', body: 'Your own Cipher bots, running on this computer. Here are five quick tips; you can skip them at any time.' },
  { icon: 'assets/cipher-tip-2-create-bot.svg', title: 'Create a bot', body: 'Press + in the left column, give it a name and a job, or start from Writer, Researcher or Files.' },
  { icon: 'assets/cipher-tip-3-folder.svg', title: 'Attach a folder', body: 'In the plus menu, turn on Read files and choose a folder. The bot can then read text files and PDFs in it; nothing outside it.' },
  { icon: 'assets/cipher-tip-4-private.svg', title: 'Private and local', body: 'Chats stay in cipher.db on this computer and replies come from the local model. Online is off until you turn it on in Settings.' },
  { icon: 'assets/cipher-tip-5-shortcuts.svg', title: 'Shortcuts', body: 'Enter sends, Shift+Enter adds a line, Escape closes menus. The full list is in Settings.' },
];
