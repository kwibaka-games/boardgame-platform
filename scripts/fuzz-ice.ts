/**
 * Random-policy fuzz agent for 《冰冷的她醒来之前》.
 *
 * It drives the real IceMatch state machine (not a mock) with legal actions
 * taken directly from each player's latest `view.actions`. It checks per-view
 * privacy, card conservation, sequence/result invariants, and that every random
 * game terminates.
 *
 * Usage:
 *   npx tsx scripts/fuzz-ice.ts 2000
 */
import { IceMatch } from '../src/games/ice/game.js';
import { deckSize } from '../src/games/ice/cards.js';
import type { GameToPlatform, Seat } from '../src/protocol/protocol.js';
import type { IceAction, IceMode, IceView } from '../src/games/ice/types.js';

const TOTAL = Number(process.argv[2] || 1000);
if (!Number.isInteger(TOTAL) || TOTAL < 1) {
  console.error('usage: npx tsx scripts/fuzz-ice.ts [games]');
  process.exit(2);
}

// Deterministic per-game seed; a failure prints the game number.
function makeRng(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

interface Captured {
  view: IceView;
  actions: IceAction[];
  seq: number;
}

interface GameStats {
  actions: number;
  types: Record<string, number>;
  modes: Record<IceMode, number>;
  players: Record<number, number>;
}

const stats: GameStats = { actions: 0, types: {}, modes: { standard: 0, chaos: 0 }, players: {} };
const failures: string[] = [];

function fail(game: number, seed: number, message: string): never {
  const detail = `game=${game} seed=${seed}: ${message}`;
  failures.push(detail);
  throw new Error(detail);
}

function cardIds(view: IceView): Map<string, number> {
  const ids = new Map<string, number>();
  const add = (id: string) => ids.set(id, (ids.get(id) ?? 0) + 1);
  for (const player of view.players) {
    for (const card of player.hand ?? []) add(card.id);
    for (const card of player.front ?? []) add(card.id);
  }
  for (const pile of view.piles.accusations) {
    for (const card of pile.cards ?? []) add(card.id);
  }
  for (const card of view.piles.preservation.cards ?? []) add(card.id);
  for (const card of view.piles.discard.cards ?? []) add(card.id);
  return ids;
}

function checkView(
  game: number,
  seed: number,
  message: Extract<GameToPlatform, { t: 'view' }>,
  expectedDeck: number,
): Captured {
  const view = message.view as IceView;
  const where = `seq=${message.seq} to=${message.to}`;
  if (view.phase !== view.status) fail(game, seed, `${where}: phase/status mismatch`);
  if (view.players.length < 3 || view.players.length > 6) fail(game, seed, `${where}: bad player count`);
  if (view.piles.discard.count !== view.piles.discard.cards.length) {
    fail(game, seed, `${where}: discard count mismatch`);
  }
  const spectator = message.to === 'spectator';
  if (spectator) {
    if (view.you !== null) fail(game, seed, `${where}: spectator has you`);
    if (message.actions.length !== 0) fail(game, seed, `${where}: spectator got actions`);
    for (const player of view.players) {
      if (!player.hand) fail(game, seed, `${where}: spectator missing hand`);
      if (player.handCount !== player.hand.length) fail(game, seed, `${where}: hand count mismatch`);
    }
    if (!view.piles.preservation.cards) fail(game, seed, `${where}: spectator missing preservation cards`);
    for (const pile of view.piles.accusations) {
      if (!pile.cards) fail(game, seed, `${where}: spectator missing accusation cards`);
      if (pile.count !== pile.cards.length) fail(game, seed, `${where}: accusation count mismatch`);
    }
    const ids = cardIds(view);
    if (ids.size !== expectedDeck) fail(game, seed, `${where}: deck size ${ids.size} != ${expectedDeck}`);
    for (const [id, count] of ids) {
      if (count !== 1) fail(game, seed, `${where}: duplicate card ${id} x${count}`);
    }
  } else {
    if (!message.to.startsWith('player:')) fail(game, seed, `${where}: bad target`);
    const playerId = message.to.slice('player:'.length);
    if (!view.you || view.you.userId !== playerId) fail(game, seed, `${where}: wrong you`);
    for (const player of view.players) {
      if (player.hand) fail(game, seed, `${where}: player leaked another hand`);
      if (view.phase !== 'finished' && player.identity) {
        fail(game, seed, `${where}: player leaked identity`);
      }
    }
    if (view.phase !== 'finished' && view.piles.preservation.cards) {
      fail(game, seed, `${where}: player leaked preservation cards`);
    }
    for (const pile of view.piles.accusations) {
      if (view.phase !== 'finished' && pile.cards) {
        fail(game, seed, `${where}: player leaked accusation cards`);
      }
    }
    if (!view.you.hand) fail(game, seed, `${where}: missing own hand`);
    if (view.you.hand.length !== view.players.find((p) => p.userId === playerId)?.handCount) {
      fail(game, seed, `${where}: own hand count mismatch`);
    }
    // A non-owner's summary pending must not carry private card options.
    // `pendingViewFor` and `personalPendingFor` build separate objects, so
    // compare ownership/fields rather than object identity.
    if (!view.you.pending && view.pending) {
      if (view.pending.cards?.length || view.pending.options?.length) {
        fail(game, seed, `${where}: summary pending leaked cards`);
      }
    }
  }
  return { view, actions: message.actions as IceAction[], seq: message.seq };
}

function playOne(game: number): void {
  const seed = (0x12345678 ^ Math.imul(game + 1, 0x9e3779b1)) >>> 0;
  const rng = makeRng(seed);
  const mode: IceMode = game % 2 === 0 ? 'standard' : 'chaos';
  const playerCount = 3 + (game % 4);
  stats.modes[mode] += 1;
  stats.players[playerCount] = (stats.players[playerCount] ?? 0) + 1;

  const seats: Seat[] = Array.from({ length: playerCount }, (_, index) => ({
    userId: `f${game}u${index}`,
    name: `F${game}P${index}`,
    seat: index,
  }));
  const latest = new Map<string, Captured>();
  let result: Record<string, unknown> | null = null;
  let resultCount = 0;
  let started = false;
  const lastSeq = new Map<string, number>();
  const expectedDeck = deckSize(playerCount);

  const send = (message: GameToPlatform) => {
    if (message.t === 'view') {
      const captured = checkView(game, seed, message, expectedDeck);
      latest.set(message.to, captured);
      const previous = lastSeq.get(message.to) ?? 0;
      if (message.seq < previous) fail(game, seed, `seq went backwards for ${message.to}`);
      lastSeq.set(message.to, message.seq);
    } else if (message.t === 'match.started') {
      started = true;
    } else if (message.t === 'result') {
      result = message.result as Record<string, unknown>;
      resultCount += 1;
    }
  };

  const match = new IceMatch({
    matchId: `fuzz-${game}`,
    seats,
    mode,
    send,
    turnTimeoutMs: 0,
    pendingTimeoutMs: 0,
  });

  for (const seat of seats) match.ready(seat.userId);
  if (!started) fail(game, seed, 'game did not start after all players ready');

  let steps = 0;
  const maxSteps = 5000;
  while (!result) {
    if (steps >= maxSteps) fail(game, seed, `stalled after ${steps} actions`);
    const candidates: { playerId: string; actions: IceAction[] }[] = [];
    for (const seat of seats) {
      const captured = latest.get(`player:${seat.userId}`);
      if (!captured || captured.view.phase !== 'playing') continue;
      // A peek is informational only (blocking:false). It may coexist with a
      // live turn if the turn wrapped back to the same player.
      if (captured.actions.length > 0) {
        candidates.push({ playerId: seat.userId, actions: captured.actions });
      } else if (
        captured.view.you?.pending?.blocking &&
        !(
          captured.view.you.pending.kind === 'simultaneous' &&
          captured.view.you.pending.submitted?.includes(seat.userId)
        )
      ) {
        const pending = captured.view.you.pending;
        fail(
          game,
          seed,
          `blocking pending without actions for ${seat.userId} ` +
            `kind=${pending.kind} purpose=${pending.purpose ?? ''} ` +
            `hand=${captured.view.you.hand.length} ` +
            `pending=${JSON.stringify(pending)}`,
        );
      }
    }
    if (candidates.length === 0) {
      const dump = seats.map((seat) => {
        const captured = latest.get(`player:${seat.userId}`);
        return {
          player: seat.userId,
          phase: captured?.view.phase,
          turn: captured?.view.turn,
          hand: captured?.view.you?.hand.length,
          pending: captured?.view.you?.pending,
          actions: captured?.actions.length,
        };
      });
      fail(game, seed, `no player has a legal action and the game is not over: ${JSON.stringify(dump)}`);
    }
    const candidate = pick(rng, candidates);
    const action = pick(rng, candidate.actions);
    if (!action || typeof action !== 'object') fail(game, seed, 'picked invalid action');
    stats.actions += 1;
    const type = String((action as { type?: unknown }).type ?? 'unknown');
    stats.types[type] = (stats.types[type] ?? 0) + 1;

    const outcome = match.act(candidate.playerId, action);
    if (!outcome.ok) {
      fail(
        game,
        seed,
        `action rejected player=${candidate.playerId} type=${type} error=${outcome.error ?? ''}`,
      );
    }
    steps += 1;
  }

  if (resultCount !== 1) fail(game, seed, `result count ${resultCount}`);
  const winners = (result as { winners?: unknown }).winners;
  if (!Array.isArray(winners)) fail(game, seed, 'result.winners is not an array');
  const playerIds = new Set(seats.map((seat) => seat.userId));
  for (const winner of winners) {
    if (typeof winner !== 'string' || !playerIds.has(winner)) {
      fail(game, seed, `bad winner ${String(winner)}`);
    }
  }
  for (const seat of seats) {
    const final = latest.get(`player:${seat.userId}`);
    if (!final || final.view.phase !== 'finished') fail(game, seed, `player ${seat.userId} missing final view`);
    if (!final.view.result) fail(game, seed, 'final view missing result');
    if (final.view.you?.hand.length !== 1) {
      fail(game, seed, `player ${seat.userId} ended with ${final.view.you?.hand.length} cards`);
    }
  }
}

const startedAt = Date.now();
for (let game = 0; game < TOTAL; game += 1) {
  try {
    playOne(game);
  } catch (error) {
    console.error(`\nFAILED game ${game}: ${(error as Error).message}`);
    process.exitCode = 1;
    break;
  }
  if ((game + 1) % 100 === 0) {
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`checked ${game + 1}/${TOTAL} games (${elapsed}s)`);
  }
}

const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2);
console.log('\n--- fuzz summary ---');
console.log(`games requested: ${TOTAL}`);
console.log(`games completed: ${TOTAL - failures.length}`);
console.log(`actions: ${stats.actions}`);
console.log(`modes: ${JSON.stringify(stats.modes)}`);
console.log(`players: ${JSON.stringify(stats.players)}`);
console.log(`action types: ${JSON.stringify(stats.types)}`);
console.log(`failures: ${failures.length}`);
console.log(`elapsed: ${elapsed}s`);
if (failures.length) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
}
