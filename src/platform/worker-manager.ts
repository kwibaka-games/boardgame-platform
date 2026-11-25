import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GAME_CATALOG } from './game-catalog.js';
import type { GameId, MatchId, RoomId, Seat } from '../protocol/protocol.js';

interface WorkerRecord {
  child: ChildProcess;
  roomId: RoomId;
  gameId: GameId;
  expectedStop: boolean;
}

export interface SpawnWorkerOptions {
  roomId: RoomId;
  matchId: MatchId;
  gameId: GameId;
  seats: Seat[];
  settings: Record<string, unknown>;
}

export class WorkerManager {
  private baseUrl = '';
  private readonly records = new Map<MatchId, WorkerRecord>();
  private crashHandler: (matchId: MatchId, reason: string) => void = () => {};

  constructor(
    private readonly secret: string,
    private readonly logDir: string,
  ) {}

  setBaseUrl(url: string): void {
    this.baseUrl = url;
  }

  setCrashHandler(handler: (matchId: MatchId, reason: string) => void): void {
    this.crashHandler = handler;
  }

  spawn(options: SpawnWorkerOptions): void {
    if (!this.baseUrl) throw new Error('worker base url is not configured');
    const entry = GAME_CATALOG.find((candidate) => candidate.metadata.id === options.gameId);
    if (!entry) throw new Error(`unknown game: ${options.gameId}`);

    const useDist = process.env.NODE_ENV === 'production' && existsSync(entry.worker.dist);
    const command = entry.worker.command ?? process.execPath;
    const args = entry.worker.command
      ? entry.worker.args ?? []
      : useDist
        ? [entry.worker.dist]
        : ['--import', 'tsx', entry.worker.src];

    const child = spawn(command, args, {
      cwd:
        process.env.APP_ROOT ||
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
      env: {
        ...process.env,
        MATCH_ID: options.matchId,
        ROOM_ID: options.roomId,
        GAME_ID: options.gameId,
        PLATFORM_WS_URL: this.baseUrl,
        GAME_SECRET: this.secret,
        SEATS_JSON: JSON.stringify(options.seats),
        SETTINGS_JSON: JSON.stringify(options.settings),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const prefix = `[game:${options.gameId}:${options.matchId.slice(0, 8)}]`;
    child.stdout?.on('data', (chunk: Buffer) => {
      process.stdout.write(`${prefix} ${chunk.toString()}`);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(`${prefix} ${chunk.toString()}`);
    });

    const record: WorkerRecord = {
      child,
      roomId: options.roomId,
      gameId: options.gameId,
      expectedStop: false,
    };
    this.records.set(options.matchId, record);

    child.on('error', (error) => {
      this.crash(options.matchId, record, `spawn error: ${error.message}`);
    });
    child.on('exit', (code, signal) => {
      if (record.expectedStop) {
        this.records.delete(options.matchId);
        return;
      }
      this.crash(options.matchId, record, `worker exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
    });
  }

  private crash(matchId: MatchId, record: WorkerRecord, reason: string): void {
    if (!this.records.has(matchId)) return;
    this.records.delete(matchId);
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      matchId,
      roomId: record.roomId,
      gameId: record.gameId,
      reason,
    });
    console.error(`[worker-crash] ${line}`);
    try {
      mkdirSync(this.logDir, { recursive: true });
      appendFileSync(path.join(this.logDir, 'crashes.log'), `${line}\n`, 'utf8');
    } catch (error) {
      console.error('[worker-crash] could not write crash log', (error as Error).message);
    }
    this.crashHandler(matchId, reason);
  }

  activeCount(): number {
    return this.records.size;
  }

  getPid(matchId: MatchId): number | null {
    return this.records.get(matchId)?.child.pid ?? null;
  }

  kill(matchId: MatchId): void {
    const record = this.records.get(matchId);
    if (!record) return;
    record.expectedStop = true;
    this.records.delete(matchId);
    record.child.kill('SIGTERM');
    const timer = setTimeout(() => {
      if (record.child.exitCode === null) record.child.kill('SIGKILL');
    }, 1500);
    timer.unref();
  }

  shutdown(): void {
    for (const matchId of [...this.records.keys()]) this.kill(matchId);
  }
}
