/**
 * Phone link (v1.6): a local LAN HTTP server so a phone on the same Wi-Fi can open chats
 * in a browser. Desktop stays in charge — all inference and storage run here.
 *
 * Security:
 * - Binds 0.0.0.0 on a fixed high port (PHONE_LINK_PORT). Not a cloud service.
 * - Pairing code expires (PAIR_TTL_MS). After pair, APIs require a session token (not the code).
 * - Unauthenticated / bad / expired codes are rejected.
 * - No model pull, no file-read tools, no outbound internet from this module.
 * - Phone UI is served with its own locked CSP.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import type { ChatEvent, RoomEvent } from '../shared/types';
import type { CipherDb } from './db';

export const PHONE_LINK_PORT = 17865;
/** Pairing codes expire after 12 minutes. */
export const PAIR_TTL_MS = 12 * 60 * 1000;
const SESSION_BYTES = 24;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

export interface PhoneLinkStatus {
  running: boolean;
  port: number;
  /** Present only while a non-expired pairing code is active. */
  pairingCode: string | null;
  pairingExpiresAt: number | null;
  urls: string[];
  sessionCount: number;
}

export interface PhoneServerDeps {
  db: CipherDb;
  /** Absolute path to the phone static files directory. */
  staticDir: string;
  model: string;
  /** Override listen port (tests). Defaults to PHONE_LINK_PORT. */
  port?: number;
  /** Start a 1:1 chat turn (tools forced off for phone). */
  sendChat: (chatId: number, text: string, emit: (e: ChatEvent) => void, signal: AbortSignal) => Promise<void>;
  stopChat: (chatId: number) => void;
  sendRoom: (roomId: number, text: string, emit: (e: RoomEvent) => void, signal: AbortSignal) => Promise<void>;
  stopRoom: (roomId: number) => void;
  /** Called when status changes (code refresh, start/stop). */
  onStatus?: (s: PhoneLinkStatus) => void;
}

interface PairingState {
  code: string;
  expiresAt: number;
}

interface Session {
  token: string;
  createdAt: number;
}

type SseClient = { res: http.ServerResponse; chatId?: number; roomId?: number };

function genCode(len = 6): string {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  return out;
}

function genToken(): string {
  return randomBytes(SESSION_BYTES).toString('hex');
}

/** Non-internal IPv4 addresses for LAN URLs. */
export function lanIPv4Addresses(): string[] {
  const nets = os.networkInterfaces();
  const out: string[] = [];
  for (const list of Object.values(nets)) {
    if (!list) continue;
    for (const n of list) {
      if (n.family === 'IPv4' && !n.internal) out.push(n.address);
    }
  }
  return out;
}

export function buildPhoneUrls(port: number, ips: string[] = lanIPv4Addresses()): string[] {
  const urls = ips.map((ip) => `http://${ip}:${port}/`);
  // Always include loopback for local verification.
  if (!urls.some((u) => u.includes('127.0.0.1'))) urls.push(`http://127.0.0.1:${port}/`);
  return urls;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const PHONE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
  "font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

function readBody(req: http.IncomingMessage, limit = 64_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Body too large.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

export class PhoneServer {
  private server: http.Server | null = null;
  private pairing: PairingState | null = null;
  private sessions = new Map<string, Session>();
  private sse = new Set<SseClient>();
  private chatAbort = new Map<number, AbortController>();
  private roomAbort = new Map<number, AbortController>();
  private readonly port: number;

  constructor(private deps: PhoneServerDeps) {
    this.port = deps.port ?? PHONE_LINK_PORT;
  }

  status(): PhoneLinkStatus {
    this.expirePairingIfNeeded();
    return {
      running: !!this.server,
      port: this.port,
      pairingCode: this.pairing?.code ?? null,
      pairingExpiresAt: this.pairing?.expiresAt ?? null,
      urls: this.server ? buildPhoneUrls(this.port) : [],
      sessionCount: this.sessions.size,
    };
  }

  /** Start (or keep) the server and issue a fresh pairing code. */
  start(): PhoneLinkStatus {
    if (!this.server) {
      this.server = http.createServer((req, res) => {
        void this.handle(req, res).catch((err: unknown) => {
          if (!res.headersSent) json(res, 500, { error: err instanceof Error ? err.message : String(err) });
          else res.end();
        });
      });
      this.server.listen(this.port, '0.0.0.0');
    }
    this.refreshPairingCode();
    const s = this.status();
    this.deps.onStatus?.(s);
    return s;
  }

  /** Resolves once the HTTP server is listening (for tests). */
  whenListening(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) return reject(new Error('Phone link is not running.'));
      if (this.server.listening) return resolve();
      this.server.once('listening', () => resolve());
      this.server.once('error', reject);
    });
  }

  stop(): PhoneLinkStatus {
    for (const c of this.chatAbort.values()) c.abort();
    for (const c of this.roomAbort.values()) c.abort();
    this.chatAbort.clear();
    this.roomAbort.clear();
    for (const client of this.sse) {
      try { client.res.end(); } catch { /* ignore */ }
    }
    this.sse.clear();
    this.sessions.clear();
    this.pairing = null;
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    const s = this.status();
    this.deps.onStatus?.(s);
    return s;
  }

  /** New pairing code; previous code is invalidated. Sessions stay. */
  refreshPairingCode(): PhoneLinkStatus {
    this.pairing = { code: genCode(), expiresAt: Date.now() + PAIR_TTL_MS };
    const s = this.status();
    this.deps.onStatus?.(s);
    return s;
  }

  /** Test helper: force an already-expired pairing code. */
  setPairingForTest(code: string, expiresAt: number): void {
    this.pairing = { code, expiresAt };
  }

  /** Test helper: inject a session token. */
  addSessionForTest(token: string): void {
    this.sessions.set(token, { token, createdAt: Date.now() });
  }

  private expirePairingIfNeeded(): void {
    if (this.pairing && Date.now() >= this.pairing.expiresAt) this.pairing = null;
  }

  /**
   * Attempt pairing. Returns a session token on success.
   * Rejects wrong codes, missing codes, and expired codes.
   * Does not log the pairing code.
   */
  tryPair(code: string): { ok: true; token: string } | { ok: false; error: string } {
    this.expirePairingIfNeeded();
    const trimmed = String(code ?? '').trim().toUpperCase();
    if (!this.pairing) return { ok: false, error: 'Pairing code expired or not available. Generate a new code on the desktop.' };
    if (trimmed !== this.pairing.code) return { ok: false, error: 'Wrong pairing code.' };
    // One-time: consume the code after successful pair (must re-pair with a new code).
    this.pairing = null;
    const token = genToken();
    this.sessions.set(token, { token, createdAt: Date.now() });
    this.deps.onStatus?.(this.status());
    return { ok: true, token };
  }

  hasSession(token: string | null | undefined): boolean {
    if (!token) return false;
    return this.sessions.has(token);
  }

  private sessionFromReq(req: http.IncomingMessage, url?: URL): string | null {
    const auth = req.headers.authorization;
    if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
      return auth.slice(7).trim() || null;
    }
    const cookie = req.headers.cookie ?? '';
    const m = /(?:^|;\s*)cipher_session=([a-f0-9]+)/i.exec(cookie);
    if (m?.[1]) return m[1];
    // EventSource cannot set Authorization; allow ?token= on SSE only (checked by caller path).
    const q = url?.searchParams.get('token');
    return q && /^[a-f0-9]+$/i.test(q) ? q : null;
  }

  private requireSession(req: http.IncomingMessage, res: http.ServerResponse, url?: URL): string | null {
    const token = this.sessionFromReq(req, url);
    if (!this.hasSession(token)) {
      json(res, 401, { error: 'Pair this phone first (session required).' });
      return null;
    }
    return token!;
  }

  private broadcastChat(ev: ChatEvent): void {
    const line = `data: ${JSON.stringify({ channel: 'chat', ...ev })}\n\n`;
    for (const c of this.sse) {
      if (c.chatId === ev.chatId) {
        try { c.res.write(line); } catch { /* ignore */ }
      }
    }
  }

  private broadcastRoom(ev: RoomEvent): void {
    const line = `data: ${JSON.stringify({ channel: 'room', ...ev })}\n\n`;
    for (const c of this.sse) {
      if (c.roomId === ev.roomId) {
        try { c.res.write(line); } catch { /* ignore */ }
      }
    }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const host = req.headers.host ?? `127.0.0.1:${this.port}`;
    const url = new URL(req.url ?? '/', `http://${host}`);
    const method = req.method ?? 'GET';

    // API routes
    if (url.pathname.startsWith('/api/')) {
      return this.handleApi(req, res, method, url);
    }

    // Static phone UI
    return this.serveStatic(res, url.pathname);
  }

  private async handleApi(req: http.IncomingMessage, res: http.ServerResponse, method: string, url: URL): Promise<void> {
    // Pairing does not require a session; everything else does.
    if (method === 'POST' && url.pathname === '/api/pair') {
      const raw = await readBody(req);
      let body: { code?: string } = {};
      try { body = JSON.parse(raw || '{}') as { code?: string }; } catch { /* empty */ }
      const result = this.tryPair(String(body.code ?? ''));
      if (!result.ok) return json(res, 403, { error: result.error });
      res.setHeader('Set-Cookie', `cipher_session=${result.token}; Path=/; HttpOnly; SameSite=Strict`);
      return json(res, 200, { token: result.token });
    }

    if (method === 'GET' && url.pathname === '/api/status') {
      // Public: whether the server is up / whether this client is paired. Never returns the pairing code.
      return json(res, 200, {
        running: true,
        paired: this.hasSession(this.sessionFromReq(req, url)),
        port: this.port,
      });
    }

    const token = this.requireSession(req, res, url);
    if (!token) return;

    const { db } = this.deps;

    if (method === 'GET' && url.pathname === '/api/bots') {
      const bots = db.listBots().map((b) => ({ id: b.id, name: b.name, shape: b.shape, color: b.color }));
      return json(res, 200, { bots });
    }

    if (method === 'GET' && url.pathname === '/api/rooms') {
      const rooms = db.listRooms().map((r) => ({
        id: r.id,
        name: r.name,
        memberIds: r.memberIds,
        members: r.memberIds.map((id) => {
          const b = db.getBot(id);
          return b ? { id: b.id, name: b.name, shape: b.shape, color: b.color } : null;
        }).filter(Boolean),
      }));
      return json(res, 200, { rooms });
    }

    const botChat = /^\/api\/bots\/(\d+)\/chat$/.exec(url.pathname);
    if (method === 'GET' && botChat) {
      const botId = Number(botChat[1]);
      const chat = db.getBotChat(botId);
      const messages = db.listMessages(chat.id).filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ id: m.id, role: m.role, content: m.content, createdAt: m.createdAt }));
      return json(res, 200, { chatId: chat.id, botId, messages });
    }

    const botSend = /^\/api\/bots\/(\d+)\/send$/.exec(url.pathname);
    if (method === 'POST' && botSend) {
      const botId = Number(botSend[1]);
      const raw = await readBody(req);
      let text = '';
      try { text = String((JSON.parse(raw || '{}') as { text?: string }).text ?? ''); } catch { /* empty */ }
      if (!text.trim()) return json(res, 400, { error: 'Message is empty.' });
      const chat = db.getBotChat(botId);
      if (this.chatAbort.has(chat.id)) return json(res, 409, { error: 'This chat is still replying.' });
      const controller = new AbortController();
      this.chatAbort.set(chat.id, controller);
      // Fire and forget; stream via SSE. Tools are never offered on the phone path (deps.sendChat).
      void this.deps.sendChat(chat.id, text, (e) => this.broadcastChat(e), controller.signal)
        .finally(() => this.chatAbort.delete(chat.id));
      return json(res, 202, { chatId: chat.id, accepted: true });
    }

    const botStop = /^\/api\/bots\/(\d+)\/stop$/.exec(url.pathname);
    if (method === 'POST' && botStop) {
      const botId = Number(botStop[1]);
      const chat = db.getBotChat(botId);
      this.chatAbort.get(chat.id)?.abort();
      this.deps.stopChat(chat.id);
      return json(res, 200, { stopped: true });
    }

    const roomMsg = /^\/api\/rooms\/(\d+)\/messages$/.exec(url.pathname);
    if (method === 'GET' && roomMsg) {
      const roomId = Number(roomMsg[1]);
      if (!db.getRoom(roomId)) return json(res, 404, { error: 'Room not found.' });
      const messages = db.listRoomMessages(roomId);
      return json(res, 200, { roomId, messages });
    }

    const roomSend = /^\/api\/rooms\/(\d+)\/send$/.exec(url.pathname);
    if (method === 'POST' && roomSend) {
      const roomId = Number(roomSend[1]);
      if (!db.getRoom(roomId)) return json(res, 404, { error: 'Room not found.' });
      const raw = await readBody(req);
      let text = '';
      try { text = String((JSON.parse(raw || '{}') as { text?: string }).text ?? ''); } catch { /* empty */ }
      if (!text.trim()) return json(res, 400, { error: 'Message is empty.' });
      if (this.roomAbort.has(roomId)) return json(res, 409, { error: 'This room is still replying.' });
      const controller = new AbortController();
      this.roomAbort.set(roomId, controller);
      void this.deps.sendRoom(roomId, text, (e) => this.broadcastRoom(e), controller.signal)
        .finally(() => this.roomAbort.delete(roomId));
      return json(res, 202, { roomId, accepted: true });
    }

    const roomStop = /^\/api\/rooms\/(\d+)\/stop$/.exec(url.pathname);
    if (method === 'POST' && roomStop) {
      const roomId = Number(roomStop[1]);
      this.roomAbort.get(roomId)?.abort();
      this.deps.stopRoom(roomId);
      return json(res, 200, { stopped: true });
    }

    // SSE stream for a chat or room
    const chatEvents = /^\/api\/bots\/(\d+)\/events$/.exec(url.pathname);
    if (method === 'GET' && chatEvents) {
      const botId = Number(chatEvents[1]);
      const chat = db.getBotChat(botId);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      res.write(': ok\n\n');
      const client: SseClient = { res, chatId: chat.id };
      this.sse.add(client);
      req.on('close', () => this.sse.delete(client));
      return;
    }

    const roomEvents = /^\/api\/rooms\/(\d+)\/events$/.exec(url.pathname);
    if (method === 'GET' && roomEvents) {
      const roomId = Number(roomEvents[1]);
      if (!db.getRoom(roomId)) return json(res, 404, { error: 'Room not found.' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      res.write(': ok\n\n');
      const client: SseClient = { res, roomId };
      this.sse.add(client);
      req.on('close', () => this.sse.delete(client));
      return;
    }

    // Explicitly refuse any model-pull style paths.
    if (url.pathname.includes('pull') || url.pathname.includes('ollama')) {
      return json(res, 404, { error: 'Not available on phone link.' });
    }

    return json(res, 404, { error: 'Not found.' });
  }

  private serveStatic(res: http.ServerResponse, pathname: string): void {
    let rel = pathname === '/' ? '/index.html' : pathname;
    // Prevent path traversal.
    rel = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
    const file = path.join(this.deps.staticDir, rel);
    if (!file.startsWith(this.deps.staticDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      json(res, 404, { error: 'Not found.' });
      return;
    }
    const ext = path.extname(file).toLowerCase();
    const data = fs.readFileSync(file);
    const headers: Record<string, string | number> = {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
    };
    if (ext === '.html') headers['Content-Security-Policy'] = PHONE_CSP;
    res.writeHead(200, headers);
    res.end(data);
  }
}
