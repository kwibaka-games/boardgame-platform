/**
 * Protocol v1 between:
 *   - browser  <-> platform (HTTP + Socket.IO)
 *   - platform <-> game process (WebSocket, JSON)
 *
 * The important rule: a game process never sends a global "state" message.
 * It sends `view` messages with a required `to` target, and the platform only
 * routes them. That is what keeps hidden information out of the platform and
 * out of the wrong player's browser.
 */
import { z } from 'zod';

export const PROTOCOL_VERSION = 1 as const;

export type UserId = string;
export type GameId = string;
export type MatchId = string;
export type RoomId = string;

export interface GameMetadata {
  id: GameId;
  name: string;
  version: string;
  protocol: number;
  minPlayers: number;
  maxPlayers: number;
  description?: string;
  author?: string;
  /** Whether spectators may send chat messages. Perfect-information games: true. */
  spectatorChat: boolean;
}

export interface Seat {
  userId: UserId;
  name: string;
  seat: number;
  /** Ready state while the room is waiting; game workers may ignore this. */
  ready?: boolean;
}

export interface ChatMessage {
  id: string;
  roomId: RoomId;
  userId: UserId;
  name: string;
  text: string;
  ts: number;
  role: 'player' | 'spectator';
}

export interface PlayerView {
  userId: UserId;
  name: string;
  seat: number;
  connected: boolean;
  ready: boolean;
}

export interface RoomSummary {
  id: RoomId;
  name: string;
  gameId: GameId;
  gameName: string;
  ownerId: UserId;
  status: 'waiting' | 'starting' | 'playing' | 'finished';
  players: PlayerView[];
  minPlayers: number;
  maxPlayers: number;
  spectatorCount: number;
  spectatorChat: boolean;
  hasPassword: boolean;
  allReady: boolean;
}

export interface RoomView {
  id: RoomId;
  name: string;
  gameId: GameId;
  gameName: string;
  ownerId: UserId;
  status: 'waiting' | 'starting' | 'playing' | 'finished';
  minPlayers: number;
  maxPlayers: number;
  players: PlayerView[];
  matchId: MatchId | null;
  spectatorChat: boolean;
  hasPassword: boolean;
  allReady: boolean;
  spectators: { userId: UserId; name: string }[];
  you: { userId: UserId; seat: number | null; spectator: boolean };
}

// ── platform -> game ────────────────────────────────────────────────────────

export type PlatformToGame =
  | { v: 1; t: 'register.ack'; ok: true; gameId: GameId }
  | { v: 1; t: 'register.ack'; ok: false; error: string }
  | {
      v: 1;
      t: 'match.create';
      matchId: MatchId;
      gameId: GameId;
      seats: Seat[];
      settings: Record<string, unknown>;
    }
  | {
      v: 1;
      t: 'action';
      matchId: MatchId;
      playerId: UserId;
      seq: number;
      actionId: string;
      action: unknown;
    }
  | { v: 1; t: 'player.ready'; matchId: MatchId; playerId: UserId }
  | {
      v: 1;
      t: 'player.connection';
      matchId: MatchId;
      playerId: UserId;
      connected: boolean;
    }
  | { v: 1; t: 'match.abort'; matchId: MatchId; reason: string };

// ── game -> platform ────────────────────────────────────────────────────────

export type GameToPlatform =
  | { v: 1; t: 'register'; game: GameMetadata; secret: string; matchId?: MatchId }
  | {
      v: 1;
      t: 'view';
      matchId: MatchId;
      /** "player:<userId>" or "spectator" */
      to: string;
      seq: number;
      view: unknown;
      actions?: unknown[];
    }
  | {
      v: 1;
      t: 'event';
      matchId: MatchId;
      to: 'room' | string;
      event: unknown;
    }
  | { v: 1; t: 'match.started'; matchId: MatchId }
  | { v: 1; t: 'result'; matchId: MatchId; result: unknown }
  | {
      v: 1;
      t: 'error';
      matchId?: MatchId;
      playerId?: UserId;
      code: string;
      message: string;
    };

// ── browser <-> platform (Socket.IO) ────────────────────────────────────────

export interface ClientToServerEvents {
  'room.subscribe': (
    payload: { roomId: string; spectate?: boolean },
    ack?: (res: { ok: boolean; error?: string }) => void,
  ) => void;
  'room.unsubscribe': () => void;
  'chat.send': (
    payload: { text: string },
    ack?: (res: { ok: boolean; error?: string }) => void,
  ) => void;
  'game.ready': (payload: { matchId: string }) => void;
  'game.action': (
    payload: {
      matchId: string;
      seq: number;
      actionId: string;
      action: unknown;
    },
    ack?: (res: { ok: boolean; error?: string }) => void,
  ) => void;
}

export interface ServerToClientEvents {
  'room.state': (room: RoomView) => void;
  'room.players': (players: PlayerView[]) => void;
  'room.spectators': (spectators: { userId: string; name: string }[]) => void;
  'room.kicked': (payload: { roomId: string; reason?: string }) => void;
  'user.updated': (payload: { nameChangeRequired?: boolean }) => void;
  'chat.message': (message: ChatMessage) => void;
  'game.view': (payload: {
    matchId: string;
    seq: number;
    view: unknown;
    actions?: unknown[];
  }) => void;
  'game.event': (payload: { matchId: string; event: unknown }) => void;
  'game.started': (payload: { matchId: string }) => void;
  'game.result': (payload: { matchId: string; result: unknown }) => void;
  error: (payload: { code: string; message: string }) => void;
}

// ── HTTP validation ─────────────────────────────────────────────────────────

export const loginSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(6).max(128),
});

export const registerSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(128),
  name: z.string().trim().min(1).max(32),
});

export const verifyEmailSchema = z.object({
  email: z.string().trim().email().max(254),
  code: z.string().trim().regex(/^\d{6}$/),
});

export const changeEmailSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(6).max(128),
});

export const changeEmailVerifySchema = z.object({
  email: z.string().trim().email().max(254),
  code: z.string().trim().regex(/^\d{6}$/),
});

export const changeNameSchema = z.object({
  name: z.string().trim().min(1).max(32),
});

export const changeAvatarSchema = z.object({
  dataUrl: z.string().max(400_000),
});

export const createRoomSchema = z.object({
  gameId: z.string().trim().min(1).max(64),
  name: z.string().trim().max(64).optional(),
  password: z.string().trim().regex(/^\d{6}$/).optional(),
});

export const joinRoomSchema = z.object({
  password: z.string().trim().regex(/^\d{6}$/).optional(),
});

export const roomReadySchema = z.object({
  ready: z.boolean(),
});

export const adminBanSchema = z.object({
  disabled: z.boolean(),
  reason: z.string().trim().max(200).optional(),
});

export const kickSchema = z.object({
  userId: z.string().min(1),
});

export const chatTextSchema = z.string().trim().min(1).max(300);

export const gameActionEnvelopeSchema = z.object({
  matchId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  actionId: z.string().min(1).max(128),
  action: z.unknown(),
});

export const registerMessageSchema = z.object({
  v: z.literal(1),
  t: z.literal('register'),
  secret: z.string().min(1),
  matchId: z.string().min(1).optional(),
  game: z.object({
    id: z.string().min(1).max(64),
    name: z.string().min(1).max(100),
    version: z.string().min(1).max(32),
    protocol: z.number().int(),
    minPlayers: z.number().int().min(2).max(16),
    maxPlayers: z.number().int().min(2).max(16),
    description: z.string().max(500).optional(),
    author: z.string().max(100).optional(),
    spectatorChat: z.boolean().default(true),
  }),
});

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
