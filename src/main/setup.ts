import type { SetupState } from '../shared/types';
import {
  ENGINE_MISSING_MESSAGE, getStatus, MODEL_MISSING_MESSAGE, OLLAMA_HOST, pullModel, warmUp,
} from './ollama';

export interface SetupOptions {
  model: string;
  host?: string;
  fetchImpl?: typeof fetch;
  onChange?: (s: SetupState) => void;
  /** Minimum gap between progress updates sent to onChange. */
  throttleMs?: number;
}

/**
 * First-run setup: checks that the local engine is running and the model is on disk, and downloads the
 * model through the engine (/api/pull) when it is missing. The model is never bundled with the app.
 */
export class SetupManager {
  private current: SetupState = { phase: 'checking', percent: null, completed: 0, total: 0, message: null };
  private inFlight: Promise<SetupState> | null = null;
  private inFlightDownloads = false;

  constructor(private readonly opts: SetupOptions) {}

  get state(): SetupState {
    return this.current;
  }

  private set(patch: Partial<SetupState>): void {
    this.current = { ...this.current, ...patch };
    this.opts.onChange?.(this.current);
  }

  /** Check the engine and model; when `download` is true and the model is missing, download it. */
  run(download: boolean): Promise<SetupState> {
    if (this.inFlight) {
      // A check-only run is in progress but a download was asked for: run again right after it.
      return download && !this.inFlightDownloads ? this.inFlight.then(() => this.run(true)) : this.inFlight;
    }
    this.inFlightDownloads = download;
    this.inFlight = this.doRun(download).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async doRun(download: boolean): Promise<SetupState> {
    const host = this.opts.host ?? OLLAMA_HOST;
    const status = await getStatus(this.opts.model, host, this.opts.fetchImpl);
    if (!status.running) {
      this.set({ phase: 'engine-missing', message: ENGINE_MISSING_MESSAGE, percent: null });
      return this.current;
    }
    if (status.modelPresent) {
      this.set({ phase: 'ready', message: null, percent: 100 });
      void warmUp(this.opts.model, host, this.opts.fetchImpl); // load it now so the first reply is quick
      return this.current;
    }
    if (!download) {
      this.set({ phase: 'model-missing', message: MODEL_MISSING_MESSAGE, percent: null });
      return this.current;
    }
    this.set({ phase: 'downloading', message: null, percent: null, completed: 0, total: 0 });
    let last = 0;
    try {
      await pullModel({
        model: this.opts.model,
        host,
        fetchImpl: this.opts.fetchImpl,
        onProgress: (p) => {
          const now = Date.now();
          if (now - last < (this.opts.throttleMs ?? 150) && !p.done) return;
          last = now;
          this.set({ percent: p.percent, completed: p.completed, total: p.total });
        },
      });
      this.set({ phase: 'ready', message: null, percent: 100 });
      void warmUp(this.opts.model, host, this.opts.fetchImpl);
    } catch (e) {
      this.set({ phase: 'error', message: e instanceof Error ? e.message : 'Setup stopped before it finished. Choose "Try again".' });
    }
    return this.current;
  }
}
