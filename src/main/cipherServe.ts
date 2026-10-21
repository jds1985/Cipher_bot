import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getStatus, type BackendEndpoint } from './backend';
import { loadManifest, type ModelManifest } from './modelManifest';

/**
 * Runs the bundled cipher-serve (C server around Jim's ternary runtime) as a child process of the main process:
 * started on launch, health-checked, restarted (a few times, with backoff) if it dies, and stopped on quit.
 * It listens on 127.0.0.1 on a port it picks itself and requires a per-launch random bearer token.
 */

export type ServerPhase = 'stopped' | 'starting' | 'ready' | 'error';

export interface ServerPaths { binary: string; modelDir: string }

/** Where the binary and model live: packaged → process.resourcesPath/{bin,model}; dev → repo resources/. */
export function resolveServerPaths(opts: { isPackaged: boolean; resourcesPath: string; appPath: string; platform?: NodeJS.Platform; arch?: string }): ServerPaths {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const exe = platform === 'win32' ? 'cipher-serve.exe' : 'cipher-serve';
  // Same ${os}-${arch} names electron-builder uses (linux-x64, mac-arm64, win-x64).
  const tag = `${platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : platform}-${arch}`;
  if (opts.isPackaged) return { binary: path.join(opts.resourcesPath, 'bin', exe), modelDir: path.join(opts.resourcesPath, 'model') };
  return { binary: path.join(opts.appPath, 'resources', 'bin', tag, exe), modelDir: path.join(opts.appPath, 'resources', 'model') };
}

/** Threads for generation: physical-ish core count, 1..8 (8 gave no gain over 4-6 on the 135M; leaves the UI a core). */
export function defaultThreads(cpus = os.cpus().length): number {
  return Math.max(1, Math.min(8, cpus > 2 ? cpus - 1 : cpus));
}

export interface CipherServerOptions extends ServerPaths {
  threads?: number;
  /** ms to wait for "CIPHER_SERVE_LISTENING" + a healthy /health. */
  startTimeoutMs?: number;
  maxRestarts?: number;
  onChange?: (phase: ServerPhase, message: string | null) => void;
  spawnImpl?: typeof spawn;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

export const START_FAILED_MESSAGE = "Cipher's model couldn't start. Choose \"Try again\"; if it keeps happening, reinstall Cipher Bot.";
export const MODEL_FILE_MISSING_MESSAGE = "Cipher's model file is missing or damaged. Reinstall Cipher Bot to restore it.";

export class CipherServer {
  phase: ServerPhase = 'stopped';
  message: string | null = null;
  manifest: ModelManifest | null = null;
  endpoint: BackendEndpoint | null = null;
  private child: ChildProcess | null = null;
  private restarts = 0;
  private stopping = false;
  private starting: Promise<void> | null = null;

  constructor(private readonly opts: CipherServerOptions) {}

  get pid(): number | null { return this.child?.pid ?? null; }

  private set(phase: ServerPhase, message: string | null): void {
    this.phase = phase;
    this.message = message;
    this.opts.onChange?.(phase, message);
  }

  /** Start (or no-op if already starting/ready). Resolves once healthy or failed; never throws. */
  start(): Promise<void> {
    if (this.phase === 'ready') return Promise.resolve();
    if (!this.starting) this.starting = this.doStart().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async doStart(): Promise<void> {
    this.stopping = false;
    this.set('starting', null);
    let manifest: ModelManifest;
    try {
      manifest = loadManifest(this.opts.modelDir);
      const st = fs.statSync(path.join(this.opts.modelDir, manifest.file));
      if (st.size !== manifest.bytes) throw new Error(`model size ${st.size} != manifest ${manifest.bytes}`);
      fs.accessSync(this.opts.binary, fs.constants.X_OK);
    } catch (e) {
      this.opts.log?.(`[cipher-serve] not started: ${e instanceof Error ? e.message : e}`);
      this.set('error', MODEL_FILE_MISSING_MESSAGE);
      return;
    }
    this.manifest = manifest;
    const token = randomBytes(24).toString('hex');
    const args = ['--model', path.join(this.opts.modelDir, manifest.file), '--port', '0', '--threads', String(this.opts.threads ?? defaultThreads()),
      '--ctx', String(manifest.nCtx), '--id', manifest.id];
    const child = (this.opts.spawnImpl ?? spawn)(this.opts.binary, args, {
      env: { PATH: process.env.PATH ?? '', CIPHER_SERVE_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    this.child = child;
    child.stderr?.on('data', (d: Buffer) => { for (const l of d.toString().split('\n')) if (l.trim()) this.opts.log?.(l); });
    const port = await new Promise<number | null>((resolve) => {
      let out = '';
      const timer = setTimeout(() => resolve(null), this.opts.startTimeoutMs ?? 15000);
      child.stdout?.on('data', (d: Buffer) => {
        out += d.toString();
        const m = /CIPHER_SERVE_LISTENING (\d+)/.exec(out);
        if (m) { clearTimeout(timer); resolve(Number(m[1])); }
      });
      child.once('exit', () => { clearTimeout(timer); resolve(null); });
      child.once('error', () => { clearTimeout(timer); resolve(null); });
    });
    if (!port || child.exitCode !== null) { this.kill(child); this.child = null; this.set('error', START_FAILED_MESSAGE); return; }
    const endpoint = { baseUrl: `http://127.0.0.1:${port}`, token };
    const st = await getStatus(endpoint, this.opts.fetchImpl);
    if (!st.running) { this.kill(child); this.child = null; this.set('error', START_FAILED_MESSAGE); return; }
    this.endpoint = endpoint;
    child.once('exit', (code, signal) => this.onExit(child, code, signal));
    this.set('ready', null);
  }

  private onExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (child !== this.child) return;
    this.child = null;
    this.endpoint = null;
    if (this.stopping) { this.set('stopped', null); return; }
    this.opts.log?.(`[cipher-serve] exited unexpectedly (code ${code}, signal ${signal})`);
    if (this.restarts >= (this.opts.maxRestarts ?? 3)) { this.set('error', START_FAILED_MESSAGE); return; }
    const delay = 500 * 2 ** this.restarts++;
    this.set('starting', 'Restarting the Cipher model…');
    setTimeout(() => { if (!this.stopping) { this.phase = 'stopped'; void this.start(); } }, delay);
  }

  /** "Try again" from the UI: resets the restart budget. */
  retry(): Promise<void> {
    this.restarts = 0;
    if (this.phase === 'error') this.phase = 'stopped';
    return this.start();
  }

  /** Health check; flips to error (and schedules nothing) if the server stopped answering. */
  async check(): Promise<boolean> {
    const st = await getStatus(this.endpoint, this.opts.fetchImpl);
    if (!st.running && this.phase === 'ready') this.set('error', st.problem);
    return st.running;
  }

  private kill(child: ChildProcess): void {
    try { if (child.exitCode === null) child.kill('SIGKILL'); } catch { /* already gone */ }
  }

  /** Graceful stop: SIGTERM, then SIGKILL after `graceMs`. Resolves when the process is gone. */
  stop(graceMs = 2000): Promise<void> {
    this.stopping = true;
    const child = this.child;
    this.endpoint = null;
    if (!child || child.exitCode !== null) { this.child = null; this.set('stopped', null); return Promise.resolve(); }
    return new Promise((resolve) => {
      const t = setTimeout(() => this.kill(child), graceMs);
      child.once('exit', () => { clearTimeout(t); this.child = null; this.set('stopped', null); resolve(); });
      try { child.kill('SIGTERM'); } catch { clearTimeout(t); resolve(); }
    });
  }

  /** Synchronous last-resort kill for process exit paths. */
  killNow(): void {
    this.stopping = true;
    if (this.child) this.kill(this.child);
  }
}
