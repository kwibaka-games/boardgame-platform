import { randomUUID } from 'node:crypto';
import type { DefaultEventsMap, Server, Socket } from 'socket.io';
import {
  chatTextSchema,
  type ChatMessage,
  type ClientToServerEvents,
  type GameMetadata,
  type GameToPlatform,
  type MatchId,
  type PlayerView,
  type RoomSummary,
  type RoomView,
  type ServerToClientEvents,
  type Seat,
} from '../protocol/protocol.js';
import type { GameCatalog } from './game-catalog.js';
import type { WorkerHub } from './worker-hub.js';
import type { WorkerManager } from './worker-manager.js';
import {
  abortUnfinishedMatches,
  deleteRoom,
  finishMatch,
  getRoom,
  getUserById,
  insertChat,
  insertMatch,
  insertRoom,
  listChat,
  listRooms,
  markMatchAborted,
  updateRoom,
  type Db,
  type RoomRecord,
} from './db.js';
import { hashSecret, verifySecret, type AuthedUser } from './auth.js';

export interface SocketData {
  user: AuthedUser;
  roomId?: string;
  spectate?: boolean;
}

type IO = Server<ClientToServerEvents, ServerToClientEvents, DefaultEventsMap, SocketData>;
type ClientSocket = Socket<ClientToServerEvents, ServerToClientEvents, DefaultEventsMap, SocketData>;

interface RoomRuntime {
  record: RoomRecord;
  seats: Seat[];
  seq: number;
  actionIds: Set<string>;
  lastViews: Map<string, { seq: number; view: unknown; actions?: unknown[] }>;
  chatMuted: Set<string>;
}

interface SpectatorState {
  name: string;
  sockets: Set<string>;
}

const roomChannel = (roomId: string) => `room:${roomId}`;
const spectatorChannel = (roomId: string) => `room:${roomId}:spectators`;
const userChannel = (userId: string) => `user:${userId}`;

function parseSeats(json: string): Seat[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Seat => {
        return (
          !!item &&
          typeof item === 'object' &&
          typeof (item as Seat).userId === 'string' &&
          typeof (item as Seat).name === 'string' &&
          typeof (item as Seat).seat === 'number'
        );
      })
      .map((item) => ({ ...item, ready: !!item.ready }))
      .sort((a, b) => a.seat - b.seat);
  } catch {
    return [];
  }
}

function normalizeChatText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 300);
}

function extractWinners(result: unknown): string[] {
  if (!result || typeof result !== 'object') return [];
  const winners = (result as { winners?: unknown }).winners;
  if (!Array.isArray(winners)) return [];
  return winners.filter((value): value is string => typeof value === 'string');
}

function toChatMessage(record: {
  id: string;
  room_id: string;
  user_id: string;
  name: string;
  text: string;
  ts: number;
  role: 'player' | 'spectator';
}): ChatMessage {
  return {
    id: record.id,
    roomId: record.room_id,
    userId: record.user_id,
    name: record.name,
    text: record.text,
    ts: record.ts,
    role: record.role,
  };
}

export class RoomService {
  private readonly runtimes = new Map<string, RoomRuntime>();
  private readonly matchToRoom = new Map<string, string>();
  private readonly playerConnections = new Map<string, Map<string, Set<string>>>();
  private readonly spectators = new Map<string, Map<string, SpectatorState>>();
  private readonly chatTimes = new Map<string, number[]>();
  private readonly startTimers = new Map<string, NodeJS.Timeout>();
  private readonly waitTimer: NodeJS.Timeout;
  private readonly waitTimeoutMs: number;

  constructor(
    private readonly db: Db,
    private readonly io: IO,
    private readonly catalog: GameCatalog,
    private readonly workers: WorkerManager,
    private readonly hub: WorkerHub,
    waitTimeoutMs = 15 * 60_000,
  ) {
    this.waitTimeoutMs = waitTimeoutMs;
    // A game process owns live match state, so matches that were active when the
    // platform restarted cannot be resumed. They are excluded from stats.
    abortUnfinishedMatches(this.db);
    this.db
      .prepare(
        "UPDATE rooms SET status = 'waiting', match_id = NULL, updated_at = ? WHERE status IN ('starting', 'playing')",
      )
      .run(Date.now());
    this.workers.setCrashHandler((matchId, reason) =>
      this.handleWorkerCrash(matchId, reason),
    );
    this.waitTimer = setInterval(
      () => this.sweepWaitingRooms(),
      Math.min(60_000, Math.max(1_000, Math.floor(this.waitTimeoutMs / 4))),
    );
    this.waitTimer.unref();
  }

  listGames(): GameMetadata[] {
    return this.catalog.list();
  }

  listOpenRooms(): RoomSummary[] {
    return listRooms(this.db, 50).map((record) => this.summary(record));
  }

  getRoom(roomId: string, userId?: string, spectate = false): RoomView | null {
    const record = getRoom(this.db, roomId);
    return record ? this.view(record, userId, spectate) : null;
  }

  listMessages(roomId: string): ChatMessage[] {
    return listChat(this.db, roomId, 100).map(toChatMessage);
  }

  createRoom(user: AuthedUser, gameId: string, name?: string, password?: string): RoomView {
    const game = this.catalog.get(gameId);
    if (!game) throw new Error('unknown game');
    const roomId = randomUUID();
    const now = Date.now();
    const seats: Seat[] = [{ userId: user.id, name: user.name, seat: 0, ready: false }];
    const record: RoomRecord = {
      id: roomId,
      name: name?.trim() || `${user.name} 的房间`,
      game_id: gameId,
      owner_id: user.id,
      status: 'waiting',
      seats_json: JSON.stringify(seats),
      settings_json: '{}',
      password_hash: password ? hashSecret(password) : null,
      match_id: null,
      created_at: now,
      updated_at: now,
    };
    insertRoom(this.db, record);
    this.runtimes.set(roomId, {
      record,
      seats,
      seq: 0,
      actionIds: new Set(),
      lastViews: new Map(),
      chatMuted: new Set(),
    });
    return this.view(record, user.id, false);
  }

  joinRoom(user: AuthedUser, roomId: string, password?: string): RoomView {
    const runtime = this.runtime(roomId);
    if (!runtime) throw new Error('room not found');
    if (runtime.record.status !== 'waiting') throw new Error('game already in progress');
    if (runtime.seats.some((seat) => seat.userId === user.id)) {
      return this.view(runtime.record, user.id, false);
    }
    if (runtime.record.password_hash) {
      if (!password) throw new Error('需要房间密码');
      if (!verifySecret(password, runtime.record.password_hash)) throw new Error('房间密码错误');
    }
    const game = this.catalog.get(runtime.record.game_id);
    const maxPlayers = game?.maxPlayers ?? 8;
    if (runtime.seats.length >= maxPlayers) throw new Error('room is full');

    const used = new Set(runtime.seats.map((seat) => seat.seat));
    let seatNumber = 0;
    while (used.has(seatNumber)) seatNumber += 1;
    runtime.seats.push({ userId: user.id, name: user.name, seat: seatNumber, ready: false });
    runtime.seats.sort((a, b) => a.seat - b.seat);
    this.persist(runtime);
    this.broadcastPlayers(roomId);
    this.broadcastState(roomId);
    return this.view(runtime.record, user.id, false);
  }

  leaveRoom(user: AuthedUser, roomId: string): void {
    const runtime = this.runtime(roomId);
    if (!runtime) throw new Error('room not found');
    const seat = runtime.seats.find((candidate) => candidate.userId === user.id);
    if (!seat) throw new Error('not in room');

    if (runtime.record.status === 'starting' || runtime.record.status === 'playing') {
      this.abortMatch(runtime, 'player_left', 'aborted');
    }

    runtime.seats = runtime.seats.filter((candidate) => candidate.userId !== user.id);
    if (runtime.seats.length === 0) {
      this.destroyRuntime(runtime);
      this.io.to(roomChannel(roomId)).emit('room.players', []);
      return;
    }

    if (runtime.record.owner_id === user.id) {
      runtime.record.owner_id = runtime.seats[0]!.userId;
    }
    if (runtime.record.status !== 'waiting' && runtime.record.status !== 'finished') {
      runtime.record.status = 'waiting';
      runtime.record.match_id = null;
      runtime.seq = 0;
      runtime.lastViews.clear();
    }
    this.persist(runtime);
    this.broadcastPlayers(roomId);
    this.broadcastSpectators(roomId);
    this.broadcastState(roomId);
  }

  startRoom(user: AuthedUser, roomId: string): void {
    const runtime = this.runtime(roomId);
    if (!runtime) throw new Error('room not found');
    if (runtime.record.owner_id !== user.id) throw new Error('only the room owner can start');
    if (runtime.record.status !== 'waiting') throw new Error('game already started');
    const game = this.catalog.get(runtime.record.game_id);
    if (!game) throw new Error('unknown game');
    if (runtime.seats.length < game.minPlayers) {
      throw new Error(`need at least ${game.minPlayers} players`);
    }
    if (runtime.seats.length > game.maxPlayers) throw new Error('too many players');
    if (!runtime.seats.every((seat) => seat.ready)) {
      throw new Error('所有玩家准备后才能开始');
    }

    const matchId = randomUUID();
    runtime.record.status = 'starting';
    runtime.record.match_id = matchId;
    runtime.seq = 0;
    runtime.actionIds.clear();
    runtime.lastViews.clear();
    runtime.chatMuted.clear();
    this.persist(runtime);
    this.matchToRoom.set(matchId, roomId);
    insertMatch(this.db, {
      id: matchId,
      roomId,
      gameId: runtime.record.game_id,
      seats: runtime.seats,
    });

    try {
      this.workers.spawn({
        roomId,
        matchId,
        gameId: runtime.record.game_id,
        seats: runtime.seats,
        settings: this.matchSettings(runtime.record),
      });
      const timer = setTimeout(() => {
        this.handleWorkerCrash(matchId, 'worker register timeout');
      }, 10_000);
      timer.unref();
      this.startTimers.set(matchId, timer);
    } catch (error) {
      this.resetToWaiting(runtime);
      throw new Error(`could not start game worker: ${(error as Error).message}`);
    }
    this.broadcastState(roomId);
  }

  /** Called by WorkerHub after a worker registers for a match. */
  handleWorkerRegister(matchId: MatchId, gameId: string): void {
    this.clearStartTimer(matchId);
    const runtime = this.roomForMatch(matchId);
    if (!runtime || runtime.record.game_id !== gameId) return;
    if (runtime.record.status !== 'starting') return;
    const sent = this.hub.send(matchId, {
      v: 1,
      t: 'match.create',
      matchId,
      gameId,
      seats: runtime.seats,
      settings: this.matchSettings(runtime.record),
    });
    if (!sent) this.handleWorkerCrash(matchId, 'worker was not reachable after register');
  }

  handleGameMessage = (gameId: string, message: GameToPlatform): void => {
    switch (message.t) {
      case 'view': {
        const runtime = this.roomForMatch(message.matchId);
        if (!runtime || runtime.record.game_id !== gameId) return;
        runtime.seq = Math.max(runtime.seq, message.seq);
        runtime.lastViews.set(message.to, {
          seq: message.seq,
          view: message.view,
          actions: message.actions,
        });
        const payload = {
          matchId: message.matchId,
          seq: message.seq,
          view: message.view,
          actions: message.actions,
        };
        if (message.to === 'spectator') {
          this.io.to(spectatorChannel(runtime.record.id)).emit('game.view', payload);
        } else if (message.to.startsWith('player:')) {
          this.io.to(userChannel(message.to.slice('player:'.length))).emit('game.view', payload);
        }
        return;
      }
      case 'event': {
        const runtime = this.roomForMatch(message.matchId);
        if (!runtime) return;
        if (message.to === 'room') {
          this.io.to(roomChannel(runtime.record.id)).emit('game.event', {
            matchId: message.matchId,
            event: message.event,
          });
        } else if (message.to.startsWith('player:')) {
          this.io
            .to(userChannel(message.to.slice('player:'.length)))
            .emit('game.event', { matchId: message.matchId, event: message.event });
        }
        return;
      }
      case 'chat.policy': {
        const runtime = this.roomForMatch(message.matchId);
        if (!runtime) return;
        runtime.chatMuted = new Set(message.mutedUserIds);
        for (const seat of runtime.seats) {
          this.io.to(userChannel(seat.userId)).emit('game.event', {
            matchId: message.matchId,
            event: {
              type: 'chat.policy',
              canChat: !runtime.chatMuted.has(seat.userId),
            },
          });
        }
        return;
      }
      case 'match.started': {
        const runtime = this.roomForMatch(message.matchId);
        if (!runtime) return;
        runtime.record.status = 'playing';
        this.persist(runtime);
        this.io.to(roomChannel(runtime.record.id)).emit('game.started', {
          matchId: message.matchId,
        });
        this.broadcastState(runtime.record.id);
        return;
      }
      case 'result': {
        const runtime = this.roomForMatch(message.matchId);
        if (!runtime) return;
        runtime.record.status = 'finished';
        this.persist(runtime);
        this.clearStartTimer(message.matchId);
        finishMatch(this.db, message.matchId, message.result, extractWinners(message.result));
        this.hub.closeMatch(message.matchId);
        this.workers.kill(message.matchId);
        this.matchToRoom.delete(message.matchId);
        this.io.to(roomChannel(runtime.record.id)).emit('game.result', {
          matchId: message.matchId,
          result: message.result,
        });
        this.broadcastState(runtime.record.id);
        return;
      }
      case 'error': {
        if (message.matchId) {
          const runtime = this.roomForMatch(message.matchId);
          if (runtime) {
            const target = message.playerId
              ? userChannel(message.playerId)
              : roomChannel(runtime.record.id);
            this.io.to(target).emit('error', {
              code: message.code,
              message: message.message,
            });
          }
        }
        return;
      }
      default:
        return;
    }
  };

  /** A game worker exited or its socket closed unexpectedly. */
  handleWorkerCrash(matchId: MatchId, reason: string): void {
    this.clearStartTimer(matchId);
    const runtime = this.roomForMatch(matchId);
    if (!runtime || runtime.record.match_id !== matchId) return;

    console.error(
      `[room-crash] match=${matchId} room=${runtime.record.id} game=${runtime.record.game_id} reason=${reason}`,
    );
    markMatchAborted(this.db, matchId, 'crashed', reason);
    this.hub.closeMatch(matchId);
    this.workers.kill(matchId);
    this.matchToRoom.delete(matchId);
    runtime.record.status = 'waiting';
    runtime.record.match_id = null;
    runtime.record.created_at = Date.now();
    runtime.seats = runtime.seats.map((seat) => ({ ...seat, ready: false }));
    runtime.seq = 0;
    runtime.actionIds.clear();
    runtime.lastViews.clear();
    this.persist(runtime);
    this.io.to(roomChannel(runtime.record.id)).emit('error', {
      code: 'E_GAME_CRASH',
      message: '游戏进程崩溃，本局已中止（不计入统计）',
    });
    this.broadcastState(runtime.record.id);
  }

  subscribe(socket: ClientSocket, roomId: string, spectate = false): { ok: boolean; error?: string } {
    const runtime = this.runtime(roomId);
    if (!runtime) return { ok: false, error: 'room not found' };
    const seat = runtime.seats.find((candidate) => candidate.userId === socket.data.user.id);
    if (!seat && !spectate) return { ok: false, error: 'not in room' };
    if (seat && spectate) return { ok: false, error: 'players cannot spectate their own room' };

    this.unsubscribe(socket);
    socket.data.roomId = roomId;
    socket.data.spectate = !seat;
    void socket.join(roomChannel(roomId));
    if (!seat) void socket.join(spectatorChannel(roomId));

    if (seat) {
      const first = this.addPlayerConnection(roomId, socket.data.user.id, socket.id);
      if (first && runtime.record.match_id) {
        this.hub.send(runtime.record.match_id, {
          v: 1,
          t: 'player.connection',
          matchId: runtime.record.match_id,
          playerId: socket.data.user.id,
          connected: true,
        });
      }
    } else {
      this.addSpectator(roomId, socket.data.user.id, socket.data.user.name, socket.id);
    }

    socket.emit('room.state', this.view(runtime.record, socket.data.user.id, socket.data.spectate));
    for (const message of this.listMessages(roomId)) socket.emit('chat.message', message);
    const target = socket.data.spectate ? 'spectator' : `player:${socket.data.user.id}`;
    const last = runtime.lastViews.get(target);
    if (last && runtime.record.match_id) {
      socket.emit('game.view', {
        matchId: runtime.record.match_id,
        seq: last.seq,
        view: last.view,
        actions: last.actions,
      });
    }
    this.broadcastPlayers(roomId);
    this.broadcastSpectators(roomId);
    return { ok: true };
  }

  unsubscribe(socket: ClientSocket): void {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const runtime = this.runtime(roomId);
    const wasSpectator = !!socket.data.spectate;
    const userId = socket.data.user.id;
    socket.data.roomId = undefined;
    socket.data.spectate = undefined;
    void socket.leave(roomChannel(roomId));
    void socket.leave(spectatorChannel(roomId));
    if (!runtime) return;

    if (wasSpectator) {
      this.removeSpectator(roomId, userId, socket.id);
    } else {
      const removed = this.removePlayerConnection(roomId, userId, socket.id);
      if (removed && runtime.record.match_id) {
        this.hub.send(runtime.record.match_id, {
          v: 1,
          t: 'player.connection',
          matchId: runtime.record.match_id,
          playerId: userId,
          connected: false,
        });
      }
    }
    this.broadcastPlayers(roomId);
    this.broadcastSpectators(roomId);
  }

  sendChat(socket: ClientSocket, text: string): { ok: boolean; error?: string } {
    const roomId = socket.data.roomId;
    if (!roomId) return { ok: false, error: 'not in a room' };
    const runtime = this.runtime(roomId);
    if (!runtime) return { ok: false, error: 'room not found' };
    const game = this.catalog.get(runtime.record.game_id);
    const isSpectator = !!socket.data.spectate;
    if (isSpectator && !game?.spectatorChat) {
      return { ok: false, error: 'spectators cannot chat in this game' };
    }
    if (!isSpectator) {
      const seat = runtime.seats.find((candidate) => candidate.userId === socket.data.user.id);
      if (!seat) return { ok: false, error: 'not a player' };
      if (runtime.chatMuted.has(socket.data.user.id)) {
        return { ok: false, error: '你当前不能发言' };
      }
    }

    const parsed = chatTextSchema.safeParse(text);
    if (!parsed.success) return { ok: false, error: 'message must be 1-300 characters' };

    const now = Date.now();
    const times = (this.chatTimes.get(socket.data.user.id) ?? []).filter((ts) => now - ts < 10_000);
    if (times.length >= 5) return { ok: false, error: 'slow down' };
    times.push(now);
    this.chatTimes.set(socket.data.user.id, times);

    const message: ChatMessage = {
      id: randomUUID(),
      roomId,
      userId: socket.data.user.id,
      name: socket.data.user.name,
      text: normalizeChatText(parsed.data),
      ts: now,
      role: isSpectator ? 'spectator' : 'player',
    };
    insertChat(this.db, {
      id: message.id,
      room_id: roomId,
      user_id: message.userId,
      name: message.name,
      text: message.text,
      ts: message.ts,
      role: message.role,
    });
    this.io.to(roomChannel(roomId)).emit('chat.message', message);
    return { ok: true };
  }

  ready(socket: ClientSocket, matchId: string): void {
    const runtime = this.roomForMatch(matchId);
    if (!runtime || !socket.data.roomId || runtime.record.id !== socket.data.roomId) return;
    const seat = runtime.seats.find((candidate) => candidate.userId === socket.data.user.id);
    if (!seat) return;
    this.hub.send(matchId, {
      v: 1,
      t: 'player.ready',
      matchId,
      playerId: socket.data.user.id,
    });
  }

  action(
    socket: ClientSocket,
    payload: { matchId: string; seq: number; actionId: string; action?: unknown },
  ): { ok: boolean; error?: string } {
    const runtime = this.roomForMatch(payload.matchId);
    if (!runtime || !socket.data.roomId || runtime.record.id !== socket.data.roomId) {
      return { ok: false, error: 'match not found' };
    }
    if (runtime.record.status !== 'playing') return { ok: false, error: 'match is not playing' };
    const seat = runtime.seats.find((candidate) => candidate.userId === socket.data.user.id);
    if (!seat) return { ok: false, error: 'not a player' };
    if (payload.seq !== runtime.seq) return { ok: false, error: 'stale view, please resync' };
    if (runtime.actionIds.has(payload.actionId)) return { ok: true };
    runtime.actionIds.add(payload.actionId);
    if (runtime.actionIds.size > 500) {
      const first = runtime.actionIds.values().next().value;
      if (first) runtime.actionIds.delete(first);
    }
    const sent = this.hub.send(runtime.record.match_id!, {
      v: 1,
      t: 'action',
      matchId: payload.matchId,
      playerId: socket.data.user.id,
      seq: payload.seq,
      actionId: payload.actionId,
      action: payload.action,
    });
    return sent ? { ok: true } : { ok: false, error: 'game process is offline' };
  }

  setReady(user: AuthedUser, roomId: string, ready: boolean): RoomView {
    const runtime = this.runtime(roomId);
    if (!runtime) throw new Error('room not found');
    if (runtime.record.status !== 'waiting') throw new Error('game already started');
    const seat = runtime.seats.find((candidate) => candidate.userId === user.id);
    if (!seat) throw new Error('not in room');
    seat.ready = ready;
    this.persist(runtime);
    this.broadcastPlayers(roomId);
    this.broadcastState(roomId);
    return this.view(runtime.record, user.id, false);
  }

  kick(user: AuthedUser, roomId: string, targetUserId: string): void {
    const runtime = this.runtime(roomId);
    if (!runtime) throw new Error('room not found');
    if (runtime.record.owner_id !== user.id) throw new Error('only the room owner can kick');
    if (runtime.record.status !== 'waiting') throw new Error('只能在开始前踢人');
    if (targetUserId === user.id) throw new Error('不能踢出自己');
    if (!runtime.seats.some((seat) => seat.userId === targetUserId)) {
      throw new Error('玩家不在房间');
    }
    runtime.seats = runtime.seats.filter((seat) => seat.userId !== targetUserId);
    this.persist(runtime);
    this.broadcastPlayers(roomId);
    this.broadcastState(roomId);
    void this.io.to(userChannel(targetUserId)).emit('room.kicked', {
      roomId,
      reason: '你已被房主移出房间',
    });
    void this.io.in(userChannel(targetUserId)).fetchSockets().then((sockets) => {
      for (const socket of sockets) {
        const client = socket as unknown as ClientSocket;
        if (client.data.roomId === roomId) this.unsubscribe(client);
      }
    }).catch((error) => console.warn('[rooms] kick disconnect failed', error));
  }

  restart(user: AuthedUser, roomId: string): RoomView {
    const runtime = this.runtime(roomId);
    if (!runtime) throw new Error('room not found');
    if (runtime.record.owner_id !== user.id) throw new Error('only the room owner can restart');
    if (runtime.record.status !== 'finished') throw new Error('游戏还没有结束');
    if (runtime.record.match_id) this.matchToRoom.delete(runtime.record.match_id);
    runtime.record.status = 'waiting';
    runtime.record.match_id = null;
    runtime.record.created_at = Date.now();
    runtime.seq = 0;
    runtime.actionIds.clear();
    runtime.lastViews.clear();
    runtime.seats = runtime.seats.map((seat) => ({ ...seat, ready: false }));
    this.persist(runtime);
    this.broadcastPlayers(roomId);
    this.broadcastState(roomId);
    return this.view(runtime.record, user.id, false);
  }

  /** Refresh room displays after a profile avatar/flag change. */
  refreshUser(userId: string): void {
    for (const runtime of this.runtimes.values()) {
      const inSeats = runtime.seats.some((seat) => seat.userId === userId);
      const inSpectators = this.spectators.get(runtime.record.id)?.has(userId);
      if (!inSeats && !inSpectators) continue;
      this.broadcastPlayers(runtime.record.id);
      this.broadcastSpectators(runtime.record.id);
      this.broadcastState(runtime.record.id);
    }
  }

  /** Keep seat/chat names in sync after a profile rename. */
  updateSettings(user: AuthedUser, roomId: string, settings: Record<string, unknown>): RoomView {
    const runtime = this.runtime(roomId);
    if (!runtime) throw new Error('room not found');
    if (runtime.record.owner_id !== user.id) throw new Error('only the room owner can change settings');
    if (runtime.record.status !== 'waiting') throw new Error('settings can only change before start');
    runtime.record.settings_json = JSON.stringify(settings);
    this.persist(runtime);
    this.broadcastState(roomId);
    return this.view(runtime.record, user.id, false);
  }

  /** Close waiting rooms that have been idle longer than the configured limit. */
  sweepWaitingRooms(now = Date.now()): number {
    let closed = 0;
    const ids = new Set<string>([
      ...this.runtimes.keys(),
      ...listRooms(this.db, 1000).map((record) => record.id),
    ]);
    for (const id of ids) {
      const runtime = this.runtime(id);
      if (!runtime || runtime.record.status !== 'waiting') continue;
      if (now - runtime.record.created_at < this.waitTimeoutMs) continue;
      this.io.to(roomChannel(runtime.record.id)).emit('room.kicked', {
        roomId: runtime.record.id,
        reason: '房间等待开始超时，已自动关闭',
      });
      void this.io.in(roomChannel(runtime.record.id)).fetchSockets().then((sockets) => {
        for (const socket of sockets) this.unsubscribe(socket as unknown as ClientSocket);
      }).catch(() => {});
      this.destroyRuntime(runtime);
      closed += 1;
    }
    return closed;
  }

  private parseSettings(record: RoomRecord): Record<string, unknown> {
    try {
      const parsed = JSON.parse(record.settings_json) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  private matchSettings(record: RoomRecord): Record<string, unknown> {
    return { ...this.parseSettings(record), hostUserId: record.owner_id };
  }

  /** Remove a banned/deleted user from every room they occupy. */
  removeUserFromRooms(userId: string): void {
    for (const runtime of [...this.runtimes.values()]) {
      const seat = runtime.seats.find((candidate) => candidate.userId === userId);
      if (!seat) continue;
      try {
        this.leaveRoom(
          { id: userId, name: seat.name, nameChangeRequired: false },
          runtime.record.id,
        );
      } catch (error) {
        console.warn('[rooms] could not remove user from room', error);
      }
    }
  }

  updateUserName(userId: string, name: string): void {
    for (const runtime of this.runtimes.values()) {
      const seat = runtime.seats.find((candidate) => candidate.userId === userId);
      if (!seat) continue;
      seat.name = name;
      this.persist(runtime);
      this.broadcastPlayers(runtime.record.id);
      this.broadcastState(runtime.record.id);
    }
  }

  private clearStartTimer(matchId: string): void {
    const timer = this.startTimers.get(matchId);
    if (timer) {
      clearTimeout(timer);
      this.startTimers.delete(matchId);
    }
  }

  private abortMatch(runtime: RoomRuntime, reason: string, status: 'aborted' | 'crashed'): void {
    const matchId = runtime.record.match_id;
    if (matchId) {
      this.clearStartTimer(matchId);
      this.hub.send(matchId, { v: 1, t: 'match.abort', matchId, reason });
      this.hub.closeMatch(matchId);
      this.workers.kill(matchId);
      markMatchAborted(this.db, matchId, status, reason);
      this.matchToRoom.delete(matchId);
    }
    runtime.record.status = 'waiting';
    runtime.record.match_id = null;
    runtime.record.created_at = Date.now();
    runtime.seats = runtime.seats.map((seat) => ({ ...seat, ready: false }));
    runtime.seq = 0;
    runtime.actionIds.clear();
    runtime.lastViews.clear();
  }

  private resetToWaiting(runtime: RoomRuntime): void {
    runtime.record.status = 'waiting';
    runtime.seats = runtime.seats.map((seat) => ({ ...seat, ready: false }));
    runtime.record.match_id = null;
    runtime.record.created_at = Date.now();
    runtime.seq = 0;
    runtime.actionIds.clear();
    runtime.lastViews.clear();
    this.persist(runtime);
    this.broadcastState(runtime.record.id);
  }

  private destroyRuntime(runtime: RoomRuntime): void {
    if (runtime.record.match_id) {
      this.clearStartTimer(runtime.record.match_id);
      this.hub.send(runtime.record.match_id, {
        v: 1,
        t: 'match.abort',
        matchId: runtime.record.match_id,
        reason: 'room_closed',
      });
      this.hub.closeMatch(runtime.record.match_id);
      this.workers.kill(runtime.record.match_id);
      this.matchToRoom.delete(runtime.record.match_id);
    }
    this.runtimes.delete(runtime.record.id);
    deleteRoom(this.db, runtime.record.id);
  }

  private runtime(roomId: string): RoomRuntime | null {
    const existing = this.runtimes.get(roomId);
    if (existing) return existing;
    const record = getRoom(this.db, roomId);
    if (!record) return null;
    const runtime: RoomRuntime = {
      record,
      seats: parseSeats(record.seats_json),
      seq: 0,
      actionIds: new Set(),
      lastViews: new Map(),
      chatMuted: new Set(),
    };
    this.runtimes.set(roomId, runtime);
    if (record.match_id) this.matchToRoom.set(record.match_id, roomId);
    return runtime;
  }

  private roomForMatch(matchId: string): RoomRuntime | null {
    const roomId = this.matchToRoom.get(matchId);
    return roomId ? this.runtime(roomId) : null;
  }

  private persist(runtime: RoomRuntime): void {
    runtime.record.seats_json = JSON.stringify(runtime.seats);
    updateRoom(this.db, runtime.record.id, {
      status: runtime.record.status,
      seats_json: runtime.record.seats_json,
      owner_id: runtime.record.owner_id,
      match_id: runtime.record.match_id,
      name: runtime.record.name,
    });
  }

  private addPlayerConnection(roomId: string, userId: string, socketId: string): boolean {
    let byUser = this.playerConnections.get(roomId);
    if (!byUser) {
      byUser = new Map();
      this.playerConnections.set(roomId, byUser);
    }
    let sockets = byUser.get(userId);
    if (!sockets) {
      sockets = new Set();
      byUser.set(userId, sockets);
    }
    const first = sockets.size === 0;
    sockets.add(socketId);
    return first;
  }

  private removePlayerConnection(roomId: string, userId: string, socketId: string): boolean {
    const byUser = this.playerConnections.get(roomId);
    if (!byUser) return false;
    const sockets = byUser.get(userId);
    if (!sockets) return false;
    sockets.delete(socketId);
    if (sockets.size > 0) return false;
    byUser.delete(userId);
    if (byUser.size === 0) this.playerConnections.delete(roomId);
    return true;
  }

  private addSpectator(roomId: string, userId: string, name: string, socketId: string): void {
    let byUser = this.spectators.get(roomId);
    if (!byUser) {
      byUser = new Map();
      this.spectators.set(roomId, byUser);
    }
    const existing = byUser.get(userId);
    if (existing) {
      existing.sockets.add(socketId);
      return;
    }
    byUser.set(userId, { name, sockets: new Set([socketId]) });
  }

  private removeSpectator(roomId: string, userId: string, socketId: string): void {
    const byUser = this.spectators.get(roomId);
    if (!byUser) return;
    const existing = byUser.get(userId);
    if (!existing) return;
    existing.sockets.delete(socketId);
    if (existing.sockets.size === 0) byUser.delete(userId);
    if (byUser.size === 0) this.spectators.delete(roomId);
  }

  private spectatorList(roomId: string): { userId: string; name: string; avatar: string | null }[] {
    const byUser = this.spectators.get(roomId);
    if (!byUser) return [];
    return [...byUser.entries()].map(([userId, state]) => ({
      userId,
      name: state.name,
      avatar: getUserById(this.db, userId)?.avatar ?? null,
    }));
  }

  private players(roomId: string): PlayerView[] {
    const runtime = this.runtime(roomId);
    if (!runtime) return [];
    const connected = this.playerConnections.get(roomId);
    return runtime.seats.map((seat) => ({
      ...seat,
      avatar: getUserById(this.db, seat.userId)?.avatar ?? null,
      ready: !!seat.ready,
      connected: !!connected?.get(seat.userId)?.size,
    }));
  }

  private summary(record: RoomRecord): RoomSummary {
    const game = this.catalog.get(record.game_id);
    return {
      id: record.id,
      name: record.name,
      gameId: record.game_id,
      gameName: game?.name ?? record.game_id,
      ownerId: record.owner_id,
      status: record.status,
      players: this.players(record.id),
      minPlayers: game?.minPlayers ?? 2,
      maxPlayers: game?.maxPlayers ?? 8,
      spectatorCount: this.spectatorList(record.id).length,
      spectatorChat: game?.spectatorChat ?? false,
      hasPassword: !!record.password_hash,
      allReady: this.players(record.id).every((player) => player.ready),
      settings: this.parseSettings(record),
    };
  }

  private view(record: RoomRecord, userId?: string, spectate?: boolean): RoomView {
    const runtime = this.runtime(record.id);
    const game = this.catalog.get(record.game_id);
    const seats = runtime?.seats ?? parseSeats(record.seats_json);
    const seat = userId ? seats.find((candidate) => candidate.userId === userId) : undefined;
    const isSpectator = !!userId && !seat && !!spectate;
    return {
      id: record.id,
      name: record.name,
      gameId: record.game_id,
      gameName: game?.name ?? record.game_id,
      ownerId: record.owner_id,
      status: record.status,
      minPlayers: game?.minPlayers ?? 2,
      maxPlayers: game?.maxPlayers ?? 8,
      players: this.players(record.id),
      matchId: record.match_id,
      spectatorChat: game?.spectatorChat ?? false,
      hasPassword: !!record.password_hash,
      allReady: this.players(record.id).every((player) => player.ready),
      settings: this.parseSettings(record),
      spectators: this.spectatorList(record.id),
      you: {
        userId: userId ?? '',
        seat: seat?.seat ?? null,
        spectator: isSpectator,
      },
    };
  }

  private broadcastPlayers(roomId: string): void {
    this.io.to(roomChannel(roomId)).emit('room.players', this.players(roomId));
  }

  private broadcastSpectators(roomId: string): void {
    this.io.to(roomChannel(roomId)).emit('room.spectators', this.spectatorList(roomId));
  }

  private broadcastState(roomId: string): void {
    void (async () => {
      const sockets = await this.io.in(roomChannel(roomId)).fetchSockets();
      for (const socket of sockets) {
        const user = socket.data.user;
        if (!user) continue;
        const record = getRoom(this.db, roomId);
        if (record) socket.emit('room.state', this.view(record, user.id, socket.data.spectate));
      }
    })().catch((error) => console.warn('[rooms] broadcastState failed', error));
  }
}
