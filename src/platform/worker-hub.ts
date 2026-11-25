import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import {
  PROTOCOL_VERSION,
  registerMessageSchema,
  type GameToPlatform,
  type MatchId,
  type PlatformToGame,
} from '../protocol/protocol.js';
import type { GameCatalog } from './game-catalog.js';

const workerRegisterSchema = registerMessageSchema.extend({
  matchId: registerMessageSchema.shape.matchId.unwrap(),
});

interface WorkerConnection {
  ws: WebSocket;
  matchId: MatchId;
  gameId: string;
  alive: boolean;
  expectedClose: boolean;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export class WorkerHub {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly workers = new Map<MatchId, WorkerConnection>();
  private readonly heartbeat: NodeJS.Timeout;

  constructor(
    private readonly secret: string,
    private readonly catalog: GameCatalog,
    private readonly onRegister: (matchId: MatchId, gameId: string) => void,
    private readonly onMessage: (matchId: MatchId, gameId: string, message: GameToPlatform) => void,
    private readonly onCrash: (matchId: MatchId, reason: string) => void,
  ) {
    this.heartbeat = setInterval(() => this.checkHeartbeats(), 15_000);
    this.heartbeat.unref();
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/internal/game/worker') return;
    this.wss.handleUpgrade(req, socket, head, (ws) => this.handleConnection(ws));
  }

  private handleConnection(ws: WebSocket): void {
    let connection: WorkerConnection | null = null;
    const registerTimeout = setTimeout(() => {
      if (!connection) ws.close(4001, 'register timeout');
    }, 5_000);
    registerTimeout.unref();

    ws.on('pong', () => {
      if (connection) connection.alive = true;
    });

    ws.on('message', (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        ws.close(4002, 'invalid json');
        return;
      }

      if (!connection) {
        const result = workerRegisterSchema.safeParse(parsed);
        if (!result.success) {
          ws.send(
            JSON.stringify({
              v: 1,
              t: 'register.ack',
              ok: false,
              error: 'invalid worker register message',
            } satisfies PlatformToGame),
          );
          ws.close(4003, 'invalid register');
          return;
        }
        if (!safeEqual(result.data.secret, this.secret)) {
          ws.send(
            JSON.stringify({
              v: 1,
              t: 'register.ack',
              ok: false,
              error: 'invalid game secret',
            } satisfies PlatformToGame),
          );
          ws.close(4004, 'invalid secret');
          return;
        }
        if (result.data.game.protocol !== PROTOCOL_VERSION) {
          ws.send(
            JSON.stringify({
              v: 1,
              t: 'register.ack',
              ok: false,
              error: 'protocol mismatch',
            } satisfies PlatformToGame),
          );
          ws.close(4005, 'protocol mismatch');
          return;
        }
        const catalogEntry = this.catalog.get(result.data.game.id);
        if (!catalogEntry) {
          ws.send(
            JSON.stringify({
              v: 1,
              t: 'register.ack',
              ok: false,
              error: 'unknown game id',
            } satisfies PlatformToGame),
          );
          ws.close(4006, 'unknown game');
          return;
        }

        const existing = this.workers.get(result.data.matchId);
        if (existing) existing.ws.close(4007, 'replaced by newer worker');
        connection = {
          ws,
          matchId: result.data.matchId,
          gameId: result.data.game.id,
          alive: true,
          expectedClose: false,
        };
        this.workers.set(result.data.matchId, connection);
        clearTimeout(registerTimeout);
        ws.send(
          JSON.stringify({
            v: 1,
            t: 'register.ack',
            ok: true,
            gameId: result.data.game.id,
          } satisfies PlatformToGame),
        );
        this.onRegister(result.data.matchId, result.data.game.id);
        return;
      }

      if (!parsed || typeof parsed !== 'object' || !('t' in parsed)) return;
      this.onMessage(connection.matchId, connection.gameId, parsed as GameToPlatform);
    });

    ws.on('close', () => {
      clearTimeout(registerTimeout);
      if (!connection) return;
      const current = this.workers.get(connection.matchId);
      if (current?.ws !== ws) return;
      this.workers.delete(connection.matchId);
      if (!connection.expectedClose) {
        this.onCrash(connection.matchId, 'worker websocket closed');
      }
    });

    ws.on('error', (error) => {
      console.warn('[worker-hub] websocket error', error.message);
    });
  }

  private checkHeartbeats(): void {
    for (const [matchId, worker] of this.workers) {
      if (!worker.alive) {
        console.warn(`[worker-hub] heartbeat timeout ${matchId}`);
        worker.ws.terminate();
        continue;
      }
      worker.alive = false;
      try {
        worker.ws.ping();
      } catch {
        worker.ws.terminate();
      }
    }
  }

  send(matchId: MatchId, message: PlatformToGame): boolean {
    const worker = this.workers.get(matchId);
    if (!worker || worker.ws.readyState !== WebSocket.OPEN) return false;
    worker.ws.send(JSON.stringify(message));
    return true;
  }

  closeMatch(matchId: MatchId, reason = 'match finished'): void {
    const worker = this.workers.get(matchId);
    if (!worker) return;
    worker.expectedClose = true;
    this.workers.delete(matchId);
    worker.ws.close(1000, reason);
  }

  has(matchId: MatchId): boolean {
    return this.workers.has(matchId);
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const worker of this.workers.values()) {
      worker.expectedClose = true;
      worker.ws.close(1001, 'platform shutting down');
    }
    this.workers.clear();
    this.wss.close();
  }
}
