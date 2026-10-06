// Pure view decisions for the renderer (no DOM), kept separate so they can be unit-tested.
import type { SetupState } from '../shared/types';

export type MainView = 'form' | 'setup' | 'chat';

/** Phases in which the "Setting up your Cipher bot" screen covers the chats. */
export const needsSetupScreen = (st: SetupState): boolean =>
  st.phase === 'engine-missing' || st.phase === 'model-missing' || st.phase === 'downloading' || st.phase === 'error';

/**
 * First run (no Cipher bots yet) always starts on "Create a Cipher bot". After that the setup screen
 * covers chats until the model is ready. Never blocks on 'checking'.
 */
export function decideView(input: { botCount: number; formOpen: boolean; setup: SetupState }): MainView {
  if (input.formOpen || input.botCount === 0) return 'form';
  return needsSetupScreen(input.setup) ? 'setup' : 'chat';
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
