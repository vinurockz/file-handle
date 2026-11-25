import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import { lookupSession } from './auth.ts';

interface Client {
  socket: WebSocket;
  userId: string;
  tokenHash: string;
  alive: boolean;
}

export const memberIds = (db: Db, conversationId: string): string[] =>
  db
    .all<{ userId: string }>('SELECT userId FROM members WHERE conversationId = ?', conversationId)
    .map((row) => row.userId);

/** Pushes chat events to signed-in browsers. HTTP stays the only way to change data. */
export class ChatHub {
  private readonly db: Db;
  private readonly clients = new Set<Client>();
  private wss: WebSocketServer | null = null;
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(db: Db) {
    this.db = db;
  }

  attach(server: Server, config: Config): void {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
    this.wss = wss;
    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const reject = (status: string) => {
        socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
        socket.destroy();
      };
      if (new URL(request.url ?? '/', 'http://x').pathname !== '/ws')
        return reject('404 Not Found');
      // Browsers always send Origin on WebSockets; checking it blocks cross-site socket hijacking.
      if (!originAllowed(request, config)) return reject('403 Forbidden');
      const auth = lookupSession(this.db, request.headers.cookie);
      if (!auth) return reject('401 Unauthorized');
      wss.handleUpgrade(request, socket, head, (ws) =>
        this.accept(ws, auth.user.id, auth.tokenHash),
      );
    });
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) {
        if (!client.alive) {
          client.socket.terminate();
          continue;
        }
        client.alive = false;
        client.socket.ping();
      }
    }, 30_000);
    this.heartbeat.unref();
  }

  private accept(socket: WebSocket, userId: string, tokenHash: string): void {
    const wasOnline = this.isOnline(userId);
    const client: Client = { socket, userId, tokenHash, alive: true };
    this.clients.add(client);
    socket.on('pong', () => (client.alive = true));
    socket.on('error', () => socket.terminate());
    socket.on('close', () => {
      this.clients.delete(client);
      if (!this.isOnline(userId)) this.announcePresence(userId, false);
    });
    socket.on('message', (raw) => {
      try {
        const event = JSON.parse(String(raw)) as { type?: string; conversationId?: string };
        if (event.type !== 'typing' || typeof event.conversationId !== 'string') return;
        const members = memberIds(this.db, event.conversationId);
        if (!members.includes(userId)) return;
        this.send(
          members.filter((id) => id !== userId),
          { type: 'typing', conversationId: event.conversationId, userId },
        );
      } catch {
        // Ignore malformed frames rather than dropping the connection.
      }
    });
    socket.send(JSON.stringify({ type: 'ready', online: this.onlineAmongContacts(userId) }));
    if (!wasOnline) this.announcePresence(userId, true);
  }

  isOnline(userId: string): boolean {
    for (const client of this.clients) if (client.userId === userId) return true;
    return false;
  }

  private contacts(userId: string): string[] {
    return this.db
      .all<{ userId: string }>(
        `SELECT DISTINCT other.userId FROM members mine
         JOIN members other ON other.conversationId = mine.conversationId
         WHERE mine.userId = ? AND other.userId != ?`,
        userId,
        userId,
      )
      .map((row) => row.userId);
  }

  private onlineAmongContacts(userId: string): string[] {
    return this.contacts(userId).filter((id) => this.isOnline(id));
  }

  private announcePresence(userId: string, online: boolean): void {
    if (!this.wss) return;
    this.send(this.contacts(userId), { type: 'presence', userId, online });
  }

  send(userIds: Iterable<string>, event: object): void {
    const targets = new Set(userIds);
    const payload = JSON.stringify(event);
    for (const client of this.clients) {
      if (targets.has(client.userId) && client.socket.readyState === WebSocket.OPEN)
        client.socket.send(payload);
    }
  }

  endSession(tokenHash: string): void {
    for (const client of this.clients)
      if (client.tokenHash === tokenHash) client.socket.close(4001, 'Signed out');
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    const wss = this.wss;
    this.wss = null;
    for (const client of this.clients) client.socket.terminate();
    wss?.close();
  }
}

export function originAllowed(request: IncomingMessage, config: Config): boolean {
  const origin = request.headers.origin;
  if (!origin) return false;
  if (config.allowedOrigins.includes(origin)) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}
