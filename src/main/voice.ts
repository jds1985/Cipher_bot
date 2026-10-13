// v1.25: local voice input. Audio is recorded in the main window (microphone permission, audio only), sent to main
// over IPC as 16 kHz mono PCM, and transcribed here by a whisper.cpp program the user picked, with a model file the
// user picked (both in native dialogs). Cipher Bot ships no speech engine, downloads nothing, runs no install script
// and does not use Chromium's webkitSpeechRecognition (that sends audio to a server). Nothing leaves this computer.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

/** The exact engine release this was built and tested against (the user installs it themselves). */
export const WHISPER_TESTED_VERSION = 'whisper.cpp v1.7.6 (whisper-cli)';
export const VOICE_ENGINE_KEY = 'voice_engine';
export const VOICE_MODEL_KEY = 'voice_model';
export const SAMPLE_RATE = 16_000;
export const MAX_AUDIO_SECONDS = 60;
export const MAX_PCM_BYTES = SAMPLE_RATE * 2 * MAX_AUDIO_SECONDS;
export const ENGINE_NAMES = ['whisper-cli', 'whisper', 'main'];
export const TRANSCRIBE_TIMEOUT_MS = 120_000;

/** 16-bit mono PCM → a WAV file's bytes. */
export function pcmToWav(pcm: Uint8Array, rate = SAMPLE_RATE): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)]);
}

export function checkPcm(raw: unknown): Uint8Array {
  const u = raw instanceof Uint8Array ? raw : raw instanceof ArrayBuffer ? new Uint8Array(raw) : null;
  if (!u || u.byteLength < SAMPLE_RATE / 5 || u.byteLength % 2) throw new Error('Nothing was recorded. Hold the mic button while you speak.');
  if (u.byteLength > MAX_PCM_BYTES) throw new Error(`Recordings are limited to ${MAX_AUDIO_SECONDS} seconds.`);
  return u;
}

/** The whisper.cpp program the user picked: absolute, a regular executable file named like whisper.cpp's CLI. */
export async function checkEngine(p: unknown): Promise<string> {
  if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error('Choose the whisper.cpp program (whisper-cli) in Settings → Voice.');
  const real = await fs.realpath(p).catch(() => { throw new Error('The voice program is missing. Choose it again in Settings → Voice.'); });
  const st = await fs.stat(real);
  if (!st.isFile()) throw new Error('That is not a program file.');
  if (!ENGINE_NAMES.includes(path.basename(p)) && !ENGINE_NAMES.includes(path.basename(real))) throw new Error('Choose whisper.cpp\'s whisper-cli program.');
  await fs.access(real, 1 /* X_OK */).catch(() => { throw new Error('That program cannot be run (not executable).'); });
  return real;
}

/** A whisper.cpp model file (ggml .bin), checked by its first bytes. */
export async function checkModel(p: unknown): Promise<string> {
  if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error('Choose a whisper.cpp model file (.bin) in Settings → Voice.');
  const real = await fs.realpath(p).catch(() => { throw new Error('The voice model file is missing. Choose it again in Settings → Voice.'); });
  if (path.extname(real).toLowerCase() !== '.bin') throw new Error('Choose a whisper.cpp model file (ggml-….bin).');
  const fh = await fs.open(real, 'r');
  try {
    const b = Buffer.alloc(4);
    await fh.read(b, 0, 4, 0);
    if (b.readUInt32LE(0) !== 0x67676d6c) throw new Error('That file is not a whisper.cpp model.');
  } finally { await fh.close(); }
  return real;
}

/** Clean whisper.cpp output: one line of text, no [BLANK_AUDIO]-style tags. */
export function cleanTranscript(out: string): string {
  return out.replace(/\[\d[\d:.]* --> [\d:.]+\]/g, ' ').replace(/\[[A-Z_ ]+\]|\([a-z ]+\)/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000);
}

export type Runner = (file: string, args: string[], opts: { timeout: number; env: NodeJS.ProcessEnv }) => Promise<string>;
const defaultRunner: Runner = (file, args, opts) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: opts.timeout, env: opts.env, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
});

/** Write the audio to a private temp folder, run the engine on it, delete the folder. Returns the text. */
export async function transcribe(o: { engine: unknown; model: unknown; pcm: unknown; run?: Runner }): Promise<string> {
  const pcm = checkPcm(o.pcm);
  const engine = await checkEngine(o.engine);
  const model = await checkModel(o.model);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cipher-voice-'));
  try {
    const wav = path.join(dir, 'clip.wav');
    await fs.writeFile(wav, pcmToWav(pcm), { mode: 0o600 });
    const args = ['-m', model, '-f', wav, '-nt', '-np', '-t', String(Math.max(1, Math.min(8, os.cpus().length)))];
    // A small, fixed environment: no proxy variables, nothing inherited that could point it anywhere.
    const env = { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', HOME: dir };
    const out = await (o.run ?? defaultRunner)(engine, args, { timeout: TRANSCRIBE_TIMEOUT_MS, env });
    return cleanTranscript(out);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
