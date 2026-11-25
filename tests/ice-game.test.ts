import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cardCounts,
  startingHandSize,
  type CardKey,
} from '../src/games/ice/cards.js';
import { IceMatch } from '../src/games/ice/game.js';
import type { IceAction, IceMode, IceView } from '../src/games/ice/types.js';
import type { GameToPlatform, Seat } from '../src/protocol/protocol.js';

interface CapturedView {
  seq: number;
  view: IceView;
  actions: IceAction[];
}

function seatsFor(playerCount: number): Seat[] {
  return Array.from({ length: playerCount }, (_, index) => ({
    userId: `u${index}`,
    name: `P${index}`,
    seat: index,
  }));
}

/**
 * Build a legal ordered deck whose first cards go to the requested players.
 * Missing slots are filled deterministically from the remaining card pool.
 */
function deckForHands(playerCount: number, seeds: CardKey[][]): CardKey[] {
  assert.equal(seeds.length, playerCount);
  const handSize = startingHandSize(playerCount);
  const counts = cardCounts(playerCount);
  const remaining: Record<CardKey, number> = { ...counts };
  const hands = seeds.map((seed) => [...seed]);

  for (const hand of hands) {
    assert.ok(hand.length <= handSize, `seed hand too large: ${hand.length} > ${handSize}`);
    for (const key of hand) {
      const left = remaining[key] ?? 0;
      assert.ok(left > 0, `too many copies of ${key}`);
      remaining[key] = left - 1;
    }
  }

  const fillers: CardKey[] = [];
  for (const key of Object.keys(counts) as CardKey[]) {
    for (let copy = 0; copy < remaining[key]; copy += 1) fillers.push(key);
  }
  let fillIndex = 0;
  for (const hand of hands) {
    while (hand.length < handSize) {
      const key = fillers[fillIndex];
      fillIndex += 1;
      assert.ok(key, 'ran out of filler cards');
      hand.push(key);
    }
  }
  assert.equal(fillIndex, fillers.length, 'unused cards left over');

  const deck: CardKey[] = [];
  for (let row = 0; row < handSize; row += 1) {
    for (let player = 0; player < playerCount; player += 1) {
      deck.push(hands[player]![row]!);
    }
  }
  return deck;
}

interface Harness {
  match: IceMatch;
  sent: GameToPlatform[];
  seats: Seat[];
  start: () => void;
}

function setup(
  playerCount: number,
  seeds: CardKey[][],
  options: {
    rng?: () => number;
    mode?: IceMode;
    turnTimeoutMs?: number;
    pendingTimeoutMs?: number;
  } = {},
): Harness {
  const seats = seatsFor(playerCount);
  const sent: GameToPlatform[] = [];
  const match = new IceMatch({
    matchId: 'match-1',
    seats,
    deck: deckForHands(playerCount, seeds),
    send: (message) => sent.push(message),
    rng: options.rng ?? (() => 0.1),
    mode: options.mode ?? 'standard',
    turnTimeoutMs: options.turnTimeoutMs ?? 0,
    pendingTimeoutMs: options.pendingTimeoutMs ?? 0,
  });
  return {
    match,
    sent,
    seats,
    start: () => {
      for (const seat of seats) match.ready(seat.userId);
    },
  };
}

function lastGameView(sent: GameToPlatform[], userId: string): CapturedView {
  for (let index = sent.length - 1; index >= 0; index -= 1) {
    const message = sent[index]!;
    if (message.t === 'view' && message.to === `player:${userId}`) {
      return {
        seq: message.seq,
        view: message.view as IceView,
        actions: (message.actions ?? []) as IceAction[],
      };
    }
  }
  throw new Error(`no view for ${userId}`);
}

function lastSpectatorView(sent: GameToPlatform[]): IceView {
  for (let index = sent.length - 1; index >= 0; index -= 1) {
    const message = sent[index]!;
    if (message.t === 'view' && message.to === 'spectator') {
      return message.view as IceView;
    }
  }
  throw new Error('no spectator view');
}

function handOf(sent: GameToPlatform[], userId: string): { id: string; key: CardKey }[] {
  const view = lastGameView(sent, userId).view;
  return (view.you?.hand ?? []).map((card) => ({ id: card.id, key: card.key }));
}

function cardId(view: IceView, key: CardKey): string {
  const card = view.you?.hand.find((candidate) => candidate.key === key);
  assert.ok(card, `expected ${key} in hand`);
  return card.id;
}

function actionOf(
  actions: IceAction[],
  predicate: (action: IceAction) => boolean,
): IceAction {
  const action = actions.find(predicate);
  assert.ok(action, 'expected a matching action');
  return action;
}

function preserveFor(
  harness: Harness,
  userId: string,
  avoidCardId?: string | readonly string[],
): void {
  const { actions } = lastGameView(harness.sent, userId);
  const avoid = new Set(
    Array.isArray(avoidCardId)
      ? avoidCardId
      : avoidCardId
        ? [avoidCardId]
        : [],
  );
  const preserves = actions.filter((action) => action.type === 'preserve');
  const action =
    preserves.find(
      (candidate) => candidate.type === 'preserve' && !avoid.has(candidate.cardId),
    ) ?? preserves[0];
  assert.ok(action);
  const result = harness.match.act(userId, action);
  assert.equal(result.ok, true, result.error);
}

async function waitUntil(
  check: () => boolean,
  timeoutMs = 2000,
  intervalMs = 8,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('waitUntil timeout');
}

function useAction(
  harness: Harness,
  userId: string,
  cardId: string,
  targetPlayerId?: string,
): IceAction {
  return actionOf(
    lastGameView(harness.sent, userId).actions,
    (action) =>
      action.type === 'use' &&
      action.cardId === cardId &&
      (targetPlayerId === undefined || action.targetPlayerId === targetPlayerId),
  );
}

function actCurrentPreserve(harness: Harness, avoidCardId?: string): string {
  for (const seat of harness.seats) {
    const { view, actions } = lastGameView(harness.sent, seat.userId);
    if (view.phase !== 'playing' || view.turn?.playerId !== seat.userId) continue;
    if (actions.length === 0) continue;
    preserveFor(harness, seat.userId, avoidCardId);
    return seat.userId;
  }
  throw new Error('no current player');
}

function driveToFinish(harness: Harness, avoidCardId?: string): void {
  for (let step = 0; step < 200; step += 1) {
    if (harness.seats.some((seat) => lastGameView(harness.sent, seat.userId).view.phase === 'finished')) {
      return;
    }
    actCurrentPreserve(harness, avoidCardId);
  }
  throw new Error('game did not finish');
}

function useHealthAndTakeBack(harness: Harness, healthId: string): void {
  const use = actionOf(
    lastGameView(harness.sent, 'u0').actions,
    (action) => action.type === 'use' && action.cardId === healthId,
  );
  assert.equal(harness.match.act('u0', use).ok, true);
  const takeBack = actionOf(
    lastGameView(harness.sent, 'u0').actions,
    (action) => action.type === 'resolve' && action.cardId === healthId,
  );
  assert.equal(harness.match.act('u0', takeBack).ok, true);
}

/**
 * u0 repeatedly re-takes the same 保健委员 (hand size stays 6) while u1/u2
 * preserve down to one card. Used to reach the "last card" end-game.
 */
function driveOthersToOne(harness: Harness): void {
  const healthId = cardId(lastGameView(harness.sent, 'u0').view, 'health');
  for (let cycle = 0; cycle < 5; cycle += 1) {
    useHealthAndTakeBack(harness, healthId);
    preserveFor(harness, 'u1');
    preserveFor(harness, 'u2');
  }
  const view = lastGameView(harness.sent, 'u0').view;
  assert.equal(view.you?.hand.length, 6);
  assert.equal(view.players[1]?.handCount, 1);
  assert.equal(view.players[2]?.handCount, 1);
  assert.equal(view.turn?.playerId, 'u0');
}

/** Everyone preserves four times, leaving u0/u1/u2 at two cards, u0 to act. */
function driveAllToTwo(harness: Harness, avoidCardId: string): void {
  for (let cycle = 0; cycle < 4; cycle += 1) {
    preserveFor(harness, 'u0', avoidCardId);
    preserveFor(harness, 'u1');
    preserveFor(harness, 'u2');
  }
  const view = lastGameView(harness.sent, 'u0').view;
  assert.equal(view.you?.hand.length, 2);
  assert.equal(view.players[1]?.handCount, 2);
  assert.equal(view.players[2]?.handCount, 2);
  assert.equal(view.turn?.playerId, 'u0');
}

test('ice: initial deal, start player, hidden hands and spectator reveal', () => {
  const harness = setup(3, [['president'], [], []]);
  const { sent, match } = harness;

  const waiting = lastGameView(sent, 'u0');
  assert.equal(waiting.view.schema, 'ice-v1');
  assert.equal(waiting.view.phase, 'waiting');
  assert.equal(waiting.view.status, 'waiting');
  assert.equal(waiting.view.turn, null);
  assert.equal(waiting.view.you?.hand.length, 6);
  assert.equal(waiting.view.players[0]?.hand, undefined);
  assert.equal(waiting.view.config.playerCount, 3);
  assert.equal(waiting.view.config.preservationThreshold, 9);
  assert.equal(waiting.view.config.startingHandSize, 6);
  assert.equal(waiting.actions.length, 0);

  const spectator = lastSpectatorView(sent);
  assert.equal(spectator.you, null);
  assert.equal(spectator.players.every((player) => player.hand?.length === 6), true);
  assert.deepEqual(spectator.piles.preservation, { count: 0, cards: [] });

  harness.start();
  const started = lastGameView(sent, 'u0');
  assert.equal(started.view.phase, 'playing');
  assert.equal(started.view.turn?.playerId, 'u0');
  assert.equal(started.view.turn?.index, 1);
  assert.ok(started.actions.length > 0);
  assert.equal(lastGameView(sent, 'u1').actions.length, 0);

  // A player's view may not contain another player's card ids, but the
  // spectator sees all hands.
  const otherIds = (spectator.players[1]?.hand ?? []).map((card) => card.id);
  const serialized = JSON.stringify(started.view);
  for (const id of otherIds) assert.equal(serialized.includes(id), false, `leaked ${id}`);

  const spectatorSerialized = JSON.stringify(lastSpectatorView(sent));
  for (const player of lastSpectatorView(sent).players) {
    for (const card of player.hand ?? []) {
      assert.equal(spectatorSerialized.includes(card.id), true);
    }
  }

  const result = match.act('u1', lastGameView(sent, 'u1').actions[0] ?? { type: 'ready' });
  assert.equal(result.ok, false);
});

test('ice: preservation pile is count-only for players and face-up for spectators', () => {
  const harness = setup(3, [['president'], [], []]);
  harness.start();
  const before = lastGameView(harness.sent, 'u0');
  const preserve = actionOf(before.actions, (action) => action.type === 'preserve');
  assert.equal(preserve.type, 'preserve');
  assert.equal(harness.match.act('u0', preserve).ok, true);

  const afterU0 = lastGameView(harness.sent, 'u0');
  assert.equal(afterU0.view.you?.hand.length, 5);
  assert.equal(afterU0.view.piles.preservation.count, 1);
  assert.equal(afterU0.view.piles.preservation.cards, undefined);

  const afterU1 = lastGameView(harness.sent, 'u1');
  assert.equal(afterU1.view.piles.preservation.count, 1);
  assert.equal(afterU1.view.piles.preservation.cards, undefined);
  assert.equal(afterU1.view.piles.accusations.every((pile) => pile.cards === undefined), true);

  const spectator = lastSpectatorView(harness.sent);
  assert.equal(spectator.piles.preservation.count, 1);
  assert.equal(spectator.piles.preservation.cards?.length, 1);
  assert.equal(spectator.piles.preservation.cards?.[0]?.id, preserve.cardId);
  assert.equal(spectator.piles.accusations.every((pile) => Array.isArray(pile.cards)), true);
});

test('ice: accusation is hidden from players and shown to spectators', () => {
  const harness = setup(3, [['president'], [], []]);
  harness.start();
  const view = lastGameView(harness.sent, 'u0');
  const accuse = actionOf(
    view.actions,
    (action) => action.type === 'accuse' && action.targetPlayerId === 'u2',
  );
  assert.equal(accuse.type, 'accuse');
  assert.equal(harness.match.act('u0', accuse).ok, true);

  const u2 = lastGameView(harness.sent, 'u2');
  assert.equal(u2.view.players[2]?.accusationCount, 1);
  assert.equal(u2.view.piles.accusations[2]?.count, 1);
  assert.equal(u2.view.piles.accusations[2]?.cards, undefined);

  const spectator = lastSpectatorView(harness.sent);
  assert.equal(spectator.piles.accusations[2]?.cards?.[0]?.id, accuse.cardId);
});

test('ice: discard pile is public and normal-use cards move there', () => {
  const harness = setup(3, [['president', 'alien'], [], []]);
  harness.start();
  const view = lastGameView(harness.sent, 'u0');
  const alienId = cardId(view.view, 'alien');
  const use = actionOf(
    view.actions,
    (action) => action.type === 'use' && action.cardId === alienId,
  );
  assert.equal(harness.match.act('u0', use).ok, true);

  for (const userId of ['u0', 'u1', 'u2']) {
    const current = lastGameView(harness.sent, userId);
    assert.equal(current.view.piles.discard.count, 1);
    assert.equal(current.view.piles.discard.cards[0]?.id, alienId);
    assert.equal(current.view.you?.hand.some((card) => card.id === alienId), false);
  }
});

test('ice: culprit cannot be used, accused or preserved', () => {
  const harness = setup(3, [['president', 'culprit'], [], []]);
  harness.start();
  const view = lastGameView(harness.sent, 'u0').view;
  const culpritId = cardId(view, 'culprit');

  const { actions } = lastGameView(harness.sent, 'u0');
  assert.equal(actions.some((action) => 'cardId' in action && action.cardId === culpritId), false);

  for (const action of [
    { type: 'preserve', cardId: culpritId },
    { type: 'accuse', cardId: culpritId, targetPlayerId: 'u1' },
    { type: 'use', cardId: culpritId },
  ] as const) {
    const result = harness.match.act('u0', action);
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /犯人/);
  }

  // Failed actions must not change state or advance the turn.
  assert.equal(lastGameView(harness.sent, 'u0').view.turn?.playerId, 'u0');
  assert.equal(lastGameView(harness.sent, 'u0').view.you?.hand.length, 6);
});

test('ice: pre-start, out-of-turn and invalid actions are rejected', () => {
  const harness = setup(3, [['president'], [], []]);
  const before = lastGameView(harness.sent, 'u0').view;
  const card = before.you?.hand[0];
  assert.ok(card);

  const notStarted = harness.match.act('u0', { type: 'preserve', cardId: card.id });
  assert.equal(notStarted.ok, false);
  assert.equal(notStarted.code, 'E_NOT_STARTED');

  harness.start();
  const u1Card = lastGameView(harness.sent, 'u1').view.you?.hand[0];
  assert.ok(u1Card);
  const outOfTurn = harness.match.act('u1', { type: 'preserve', cardId: u1Card.id });
  assert.equal(outOfTurn.ok, false);
  assert.equal(outOfTurn.code, 'E_TURN');

  const invalid = harness.match.act('u0', { type: 'preserve', cardId: 'does-not-exist' });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'E_ILLEGAL');
});

test('ice: health committee takes a card from the public discard pile', () => {
  const harness = setup(3, [['president', 'health'], [], []]);
  harness.start();
  const start = lastGameView(harness.sent, 'u0');
  const healthId = cardId(start.view, 'health');
  const use = actionOf(start.actions, (action) => action.type === 'use' && action.cardId === healthId);
  assert.equal(harness.match.act('u0', use).ok, true);

  const pendingView = lastGameView(harness.sent, 'u0').view;
  assert.equal(pendingView.you?.pending?.kind, 'choose-card');
  assert.equal(pendingView.you?.pending?.from, 'discard');
  assert.equal(pendingView.you?.pending?.blocking, true);
  assert.equal(pendingView.you?.pending?.cards?.some((card) => card.id === healthId), true);

  // The same prompt is a public summary for other players, without card faces.
  const other = lastGameView(harness.sent, 'u1').view;
  assert.equal(other.pending?.kind, 'choose-card');
  assert.equal(other.pending?.actorId, 'u0');
  assert.equal(other.pending?.cards, undefined);

  const choice = lastGameView(harness.sent, 'u0').view.you!.pending!;
  const resolve = actionOf(
    lastGameView(harness.sent, 'u0').actions,
    (action) => action.type === 'resolve' && action.cardId === healthId,
  );
  assert.equal(harness.match.act('u0', resolve).ok, true);

  const after = lastGameView(harness.sent, 'u0').view;
  assert.equal(after.you?.hand.length, 6);
  assert.equal(after.you?.hand.some((card) => card.id === healthId), true);
  assert.equal(after.piles.discard.count, 0);
  assert.equal(after.turn?.playerId, 'u1');
  assert.equal(choice.choiceId.length > 0, true);
});

test('ice: discipline committee peeks a hand privately and the peek clears on the next action', () => {
  const harness = setup(3, [['president', 'discipline'], ['monitor'], []]);
  harness.start();
  const start = lastGameView(harness.sent, 'u0');
  const disciplineId = cardId(start.view, 'discipline');
  const use = actionOf(
    start.actions,
    (action) =>
      action.type === 'use' &&
      action.cardId === disciplineId &&
      action.targetPlayerId === 'u1',
  );
  assert.equal(harness.match.act('u0', use).ok, true);

  const actor = lastGameView(harness.sent, 'u0').view;
  assert.equal(actor.you?.pending?.kind, 'peek');
  assert.equal(actor.you?.pending?.source, 'hand');
  assert.equal(actor.you?.pending?.blocking, false);
  assert.ok(actor.you?.pending?.cards?.some((card) => card.key === 'monitor'));
  assert.equal(actor.you?.hand.length, 5);

  assert.equal(lastGameView(harness.sent, 'u1').view.pending, null);
  assert.equal(lastGameView(harness.sent, 'u1').view.you?.pending, null);

  // u1's next action clears u0's snapshot.
  preserveFor(harness, 'u1');
  const after = lastGameView(harness.sent, 'u0').view;
  assert.equal(after.pending, null);
  assert.equal(after.you?.pending, null);
});

test('ice: honors student locates the culprit and alien holders without distinguishing them', () => {
  const harness = setup(3, [['president', 'honors'], ['culprit'], ['alien']]);
  harness.start();
  const start = lastGameView(harness.sent, 'u0');
  const honorsId = cardId(start.view, 'honors');
  const use = actionOf(start.actions, (action) => action.type === 'use' && action.cardId === honorsId);
  assert.equal(harness.match.act('u0', use).ok, true);

  const peek = lastGameView(harness.sent, 'u0').view.you?.pending;
  assert.equal(peek?.kind, 'peek');
  assert.equal(peek?.source, 'identity-holders');
  assert.deepEqual(
    peek?.players?.map((player) => player.userId),
    ['u1', 'u2'],
  );
  assert.equal(peek?.cards, undefined);
});

test('ice: library committee sees the preservation pile in order', () => {
  const harness = setup(3, [['president', 'library'], ['monitor'], ['honors']]);
  harness.start();

  const libraryId = cardId(lastGameView(harness.sent, 'u0').view, 'library');
  preserveFor(harness, 'u0', libraryId);
  preserveFor(harness, 'u1');
  preserveFor(harness, 'u2');

  const before = lastSpectatorView(harness.sent).piles.preservation.cards?.map((card) => card.id) ?? [];
  assert.equal(before.length, 3);
  assert.equal(lastGameView(harness.sent, 'u0').view.turn?.playerId, 'u0');

  const use = actionOf(
    lastGameView(harness.sent, 'u0').actions,
    (action) => action.type === 'use' && action.cardId === libraryId,
  );
  assert.equal(harness.match.act('u0', use).ok, true);

  const peek = lastGameView(harness.sent, 'u0').view.you?.pending;
  assert.equal(peek?.kind, 'peek');
  assert.equal(peek?.source, 'preservation');
  assert.deepEqual(peek?.cards?.map((card) => card.id), before);
});

test('ice: a peek does not block actions when the turn wraps back to its owner', () => {
  const harness = setup(3, [['president', 'library', 'health'], ['monitor'], ['honors']]);
  harness.start();
  driveOthersToOne(harness);

  const libraryId = cardId(lastGameView(harness.sent, 'u0').view, 'library');
  const use = actionOf(
    lastGameView(harness.sent, 'u0').actions,
    (action) => action.type === 'use' && action.cardId === libraryId,
  );
  assert.equal(harness.match.act('u0', use).ok, true);

  const view = lastGameView(harness.sent, 'u0').view;
  assert.equal(view.you?.pending?.kind, 'peek');
  assert.equal(view.turn?.playerId, 'u0');
  assert.ok((lastGameView(harness.sent, 'u0').actions.length ?? 0) > 0);

  // The peek must not make the current player's turn unusable.
  const preserve = actionOf(
    lastGameView(harness.sent, 'u0').actions,
    (action) => action.type === 'preserve',
  );
  assert.equal(harness.match.act('u0', preserve).ok, true);
});

test('ice: monitor performs a simultaneous hand exchange', () => {
  const harness = setup(3, [['president', 'monitor', 'alien'], ['honors'], []]);
  harness.start();
  const start = lastGameView(harness.sent, 'u0');
  const monitorId = cardId(start.view, 'monitor');
  const alienId = cardId(start.view, 'alien');
  const honorsId = cardId(lastGameView(harness.sent, 'u1').view, 'honors');

  const use = actionOf(
    start.actions,
    (action) =>
      action.type === 'use' &&
      action.cardId === monitorId &&
      action.targetPlayerId === 'u1',
  );
  assert.equal(harness.match.act('u0', use).ok, true);

  const p0 = lastGameView(harness.sent, 'u0').view.you?.pending;
  const p1 = lastGameView(harness.sent, 'u1').view.you?.pending;
  assert.equal(p0?.kind, 'simultaneous');
  assert.equal(p1?.kind, 'simultaneous');
  assert.deepEqual(p0?.participants, ['u0', 'u1']);
  assert.equal(p0?.options?.some((card) => card.id === alienId), true);
  assert.equal(lastGameView(harness.sent, 'u2').actions.length, 0);
  // Every player receives the simultaneous pending; only the participants
  // get options and can answer it.
  const bystanderPending = lastGameView(harness.sent, 'u2').view.pending;
  assert.equal(bystanderPending?.kind, 'simultaneous');
  assert.deepEqual(bystanderPending?.participants, ['u0', 'u1']);
  assert.deepEqual(bystanderPending?.awaiting, ['u0', 'u1']);
  assert.equal(bystanderPending?.options, undefined);

  // A player who is not part of the simultaneous choice cannot answer it.
  const outsider = harness.match.act('u2', {
    type: 'resolve',
    choiceId: p0!.choiceId,
    cardId: lastGameView(harness.sent, 'u2').view.you!.hand[0]!.id,
  });
  assert.equal(outsider.ok, false);
  assert.equal(outsider.code, 'E_PENDING');

  assert.equal(
    harness.match.act('u0', { type: 'resolve', choiceId: p0!.choiceId, cardId: alienId }).ok,
    true,
  );
  const afterFirst = lastGameView(harness.sent, 'u1').view.you?.pending;
  assert.deepEqual(afterFirst?.submitted, ['u0']);
  assert.deepEqual(afterFirst?.awaiting, ['u1']);

  // Re-submitting from the same player is rejected.
  const duplicate = harness.match.act('u0', {
    type: 'resolve',
    choiceId: p0!.choiceId,
    cardId: lastGameView(harness.sent, 'u0').view.you!.hand[0]!.id,
  });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.error ?? '', /已经提交/);

  assert.equal(
    harness.match.act('u1', { type: 'resolve', choiceId: p1!.choiceId, cardId: honorsId }).ok,
    true,
  );

  const u0 = lastGameView(harness.sent, 'u0');
  const u1 = lastGameView(harness.sent, 'u1');
  assert.equal(u0.view.you?.hand.some((card) => card.id === honorsId), true);
  assert.equal(u0.view.you?.hand.some((card) => card.id === alienId), false);
  assert.equal(u1.view.you?.hand.some((card) => card.id === alienId), true);
  assert.equal(u1.view.you?.hand.some((card) => card.id === honorsId), false);
  assert.equal(u0.view.you?.hand.length, 5);
  assert.equal(u1.view.you?.hand.length, 6);
  assert.equal(u0.view.turn?.playerId, 'u1');
});

test('ice: ojou randomly takes a card and then gives one back', () => {
  const harness = setup(3, [['president', 'ojou', 'alien'], ['honors'], []]);
  harness.start();
  const start = lastGameView(harness.sent, 'u0');
  const ojouId = cardId(start.view, 'ojou');
  const alienId = cardId(start.view, 'alien');
  const u1HandBefore = lastGameView(harness.sent, 'u1').view.you?.hand.map((card) => card.id) ?? [];
  assert.ok(u1HandBefore.length > 0);

  const use = actionOf(
    start.actions,
    (action) => action.type === 'use' && action.cardId === ojouId && action.targetPlayerId === 'u1',
  );
  assert.equal(harness.match.act('u0', use).ok, true);

  const pending = lastGameView(harness.sent, 'u0').view.you?.pending;
  assert.equal(pending?.kind, 'choose-card');
  assert.equal(pending?.from, 'hand');
  assert.equal(pending?.count, 6);
  assert.equal(pending?.targetPlayerId, 'u1');

  const taken = u1HandBefore[0]!;
  assert.equal(lastGameView(harness.sent, 'u0').view.you?.hand.some((card) => card.id === taken), true);

  assert.equal(
    harness.match.act('u0', { type: 'resolve', choiceId: pending!.choiceId, cardId: alienId }).ok,
    true,
  );

  const u0 = lastGameView(harness.sent, 'u0').view;
  const u1 = lastGameView(harness.sent, 'u1').view;
  assert.equal(u0.you?.hand.length, 5);
  assert.equal(u1.you?.hand.length, 6);
  assert.equal(u0.you?.hand.some((card) => card.id === alienId), false);
  assert.equal(u1.you?.hand.some((card) => card.id === alienId), true);
});

test('ice: news club simultaneously passes one card to each previous player', () => {
  const harness = setup(3, [['president', 'news', 'alien'], ['honors'], ['monitor']]);
  harness.start();
  const start = lastGameView(harness.sent, 'u0');
  const newsId = cardId(start.view, 'news');
  const alienId = cardId(start.view, 'alien');
  const honorsId = cardId(lastGameView(harness.sent, 'u1').view, 'honors');
  const monitorId = cardId(lastGameView(harness.sent, 'u2').view, 'monitor');

  const use = actionOf(start.actions, (action) => action.type === 'use' && action.cardId === newsId);
  assert.equal(harness.match.act('u0', use).ok, true);

  const pending = lastGameView(harness.sent, 'u0').view.you?.pending;
  assert.equal(pending?.kind, 'simultaneous');
  assert.equal(pending?.purpose, 'news');
  assert.deepEqual(pending?.participants, ['u0', 'u1', 'u2']);
  assert.equal(pending?.options?.some((card) => card.id === alienId), true);

  assert.equal(
    harness.match.act('u0', { type: 'resolve', choiceId: pending!.choiceId, cardId: alienId }).ok,
    true,
  );
  assert.equal(
    harness.match.act('u1', { type: 'resolve', choiceId: pending!.choiceId, cardId: honorsId }).ok,
    true,
  );
  assert.equal(
    harness.match.act('u2', { type: 'resolve', choiceId: pending!.choiceId, cardId: monitorId }).ok,
    true,
  );

  const u0 = lastGameView(harness.sent, 'u0').view;
  const u1 = lastGameView(harness.sent, 'u1').view;
  const u2 = lastGameView(harness.sent, 'u2').view;

  // u0 -> u2, u1 -> u0, u2 -> u1 (each gives to their previous seat).
  assert.equal(u0.you?.hand.some((card) => card.id === honorsId), true);
  assert.equal(u0.you?.hand.some((card) => card.id === alienId), false);
  assert.equal(u1.you?.hand.some((card) => card.id === monitorId), true);
  assert.equal(u1.you?.hand.some((card) => card.id === honorsId), false);
  assert.equal(u2.you?.hand.some((card) => card.id === alienId), true);
  assert.equal(u2.you?.hand.some((card) => card.id === monitorId), false);
  assert.equal(u0.you?.hand.length, 5);
  assert.equal(u1.you?.hand.length, 6);
  assert.equal(u2.you?.hand.length, 6);
});

test('ice: accomplice moves a face-down accusation card between piles (4 players)', () => {
  const harness = setup(4, [['president', 'accomplice'], [], [], []]);
  harness.start();

  const accompliceId = cardId(lastGameView(harness.sent, 'u0').view, 'accomplice');
  preserveFor(harness, 'u0', accompliceId);

  const accuse = (userId: string, targetId: string) => {
    const { actions } = lastGameView(harness.sent, userId);
    const action = actionOf(
      actions,
      (candidate) =>
        candidate.type === 'accuse' && candidate.targetPlayerId === targetId,
    );
    assert.equal(harness.match.act(userId, action).ok, true);
  };
  accuse('u1', 'u2');
  accuse('u2', 'u3');
  accuse('u3', 'u1');

  assert.equal(lastGameView(harness.sent, 'u0').view.you?.hand.some((card) => card.id === accompliceId), true);
  const use = actionOf(
    lastGameView(harness.sent, 'u0').actions,
    (action) => action.type === 'use' && action.cardId === accompliceId,
  );
  assert.equal(harness.match.act('u0', use).ok, true);

  const pending = lastGameView(harness.sent, 'u0').view.you?.pending;
  assert.equal(pending?.kind, 'choose-accusation');
  assert.deepEqual(
    pending?.sources?.map((source) => [source.playerId, source.count]),
    [
      ['u1', 1],
      ['u2', 1],
      ['u3', 1],
    ],
  );

  const chooseSource = actionOf(
    lastGameView(harness.sent, 'u0').actions,
    (action) =>
      action.type === 'resolve' && action.targetPlayerId === 'u2' && action.index === 0,
  );
  assert.equal(harness.match.act('u0', chooseSource).ok, true);

  const destination = lastGameView(harness.sent, 'u0').view.you?.pending;
  assert.equal(destination?.kind, 'choose-player');
  assert.equal(destination?.candidates?.some((candidate) => candidate.userId === 'u0'), true);
  assert.equal(destination?.candidates?.some((candidate) => candidate.userId === 'u2'), false);

  const chooseDestination = actionOf(
    lastGameView(harness.sent, 'u0').actions,
    (action) => action.type === 'resolve' && action.targetPlayerId === 'u0',
  );
  assert.equal(harness.match.act('u0', chooseDestination).ok, true);

  const after = lastGameView(harness.sent, 'u0').view;
  assert.equal(after.players[0]?.accusationCount, 1);
  assert.equal(after.players[1]?.accusationCount, 1);
  assert.equal(after.players[2]?.accusationCount, 0);
  assert.equal(after.players[3]?.accusationCount, 1);
  assert.equal(after.piles.accusations[0]?.cards, undefined);

  const spectator = lastSpectatorView(harness.sent);
  assert.equal(spectator.piles.accusations[0]?.cards?.length, 1);
  assert.equal(spectator.piles.accusations[2]?.cards?.length, 0);
});

test('ice: homebody swaps a blind preservation card with a hand card', () => {
  const harness = setup(3, [['president', 'homebody', 'alien'], [], []]);
  harness.start();
  const homebodyId = cardId(lastGameView(harness.sent, 'u0').view, 'homebody');
  const alienId = cardId(lastGameView(harness.sent, 'u0').view, 'alien');

  preserveFor(harness, 'u0', homebodyId);
  preserveFor(harness, 'u1');
  preserveFor(harness, 'u2');

  const preservationBefore =
    lastSpectatorView(harness.sent).piles.preservation.cards?.map((card) => card.id) ?? [];
  assert.equal(preservationBefore.length, 3);

  const use = actionOf(
    lastGameView(harness.sent, 'u0').actions,
    (action) => action.type === 'use' && action.cardId === homebodyId,
  );
  assert.equal(harness.match.act('u0', use).ok, true);

  const pick = lastGameView(harness.sent, 'u0').view.you?.pending;
  assert.equal(pick?.kind, 'choose-card');
  assert.equal(pick?.from, 'preservation');
  assert.equal(pick?.count, 3);
  assert.equal(pick?.cards, undefined);

  const chooseIndex = actionOf(
    lastGameView(harness.sent, 'u0').actions,
    (action) => action.type === 'resolve' && action.index === 1,
  );
  assert.equal(harness.match.act('u0', chooseIndex).ok, true);

  const give = lastGameView(harness.sent, 'u0').view.you?.pending;
  assert.equal(give?.kind, 'choose-card');
  assert.equal(give?.from, 'hand');
  assert.equal(give?.count, 4);

  assert.equal(
    harness.match.act('u0', { type: 'resolve', choiceId: give!.choiceId, cardId: alienId }).ok,
    true,
  );

  const after = lastSpectatorView(harness.sent).piles.preservation.cards?.map((card) => card.id) ?? [];
  assert.equal(after.length, 3);
  assert.equal(after[1], alienId);
  assert.equal(
    lastGameView(harness.sent, 'u0').view.you?.hand.some((card) => card.id === preservationBefore[1]),
    true,
  );
});

test('ice: infected resolves at the start of the next turn and takes a preservation card', () => {
  const harness = setup(3, [['president', 'infected', 'alien'], [], []]);
  harness.start();
  const start = lastGameView(harness.sent, 'u0');
  const infectedId = cardId(start.view, 'infected');
  const use = actionOf(start.actions, (action) => action.type === 'use' && action.cardId === infectedId);
  assert.equal(harness.match.act('u0', use).ok, true);

  let u0 = lastGameView(harness.sent, 'u0').view;
  assert.equal(u0.players[0]?.front[0]?.id, infectedId);
  assert.equal(u0.you?.hand.length, 5);
  assert.equal(u0.turn?.playerId, 'u1');

  preserveFor(harness, 'u1');
  preserveFor(harness, 'u2');

  const pending = lastGameView(harness.sent, 'u0').view.you?.pending;
  assert.equal(pending?.kind, 'choose-card');
  assert.equal(pending?.from, 'preservation');
  assert.equal(pending?.purpose, 'infection');
  assert.equal(pending?.count, 2);

  const choose = actionOf(
    lastGameView(harness.sent, 'u0').actions,
    (action) => action.type === 'resolve' && action.index === 0,
  );
  assert.equal(harness.match.act('u0', choose).ok, true);

  u0 = lastGameView(harness.sent, 'u0').view;
  assert.equal(u0.you?.hand.length, 6);
  assert.equal(u0.players[0]?.front.length, 0);
  assert.equal(u0.piles.preservation.count, 1);
  assert.equal(u0.piles.discard.cards.some((card) => card.id === infectedId), true);
  assert.equal(u0.turn?.playerId, 'u0');
  assert.equal(lastGameView(harness.sent, 'u0').actions.length > 0, true);
});

test('ice: infected is discarded immediately when the preservation pile is empty', () => {
  const harness = setup(3, [['president', 'infected'], [], []]);
  harness.start();
  const infectedId = cardId(lastGameView(harness.sent, 'u0').view, 'infected');
  const use = actionOf(
    lastGameView(harness.sent, 'u0').actions,
    (action) => action.type === 'use' && action.cardId === infectedId,
  );
  assert.equal(harness.match.act('u0', use).ok, true);

  const u1Start = lastGameView(harness.sent, 'u1');
  const accuse = actionOf(
    u1Start.actions,
    (action) => action.type === 'accuse' && action.targetPlayerId === 'u2',
  );
  assert.equal(harness.match.act('u1', accuse).ok, true);
  const u2Start = lastGameView(harness.sent, 'u2');
  const accuse2 = actionOf(
    u2Start.actions,
    (action) => action.type === 'accuse' && action.targetPlayerId === 'u1',
  );
  assert.equal(harness.match.act('u2', accuse2).ok, true);

  const u0 = lastGameView(harness.sent, 'u0').view;
  assert.equal(u0.turn?.playerId, 'u0');
  assert.equal(u0.pending, null);
  assert.equal(u0.players[0]?.front.length, 0);
  assert.equal(u0.piles.discard.cards.some((card) => card.id === infectedId), true);
  assert.equal(u0.you?.hand.length, 5);
});

test('ice: last-card turns are skipped and exchange effects are not offered at two cards', () => {
  const harness = setup(3, [['president', 'monitor', 'honors', 'library'], ['monitor'], []]);
  harness.start();
  const monitorId = cardId(lastGameView(harness.sent, 'u0').view, 'monitor');

  // Drive until u0 is on turn with exactly two cards, never playing the monitor.
  for (let step = 0; step < 60; step += 1) {
    const u0 = lastGameView(harness.sent, 'u0');
    if (u0.view.you?.hand.length === 2 && u0.view.turn?.playerId === 'u0') break;
    actCurrentPreserve(harness, monitorId);
  }

  const twoCards = lastGameView(harness.sent, 'u0');
  assert.equal(twoCards.view.you?.hand.length, 2);
  assert.equal(twoCards.view.turn?.playerId, 'u0');
  assert.equal(
    twoCards.actions.some(
      (action) => action.type === 'use' && 'cardId' in action && action.cardId === monitorId,
    ),
    false,
  );
  assert.equal(twoCards.actions.some((action) => action.type === 'preserve'), true);

  // Play the non-monitor card; the monitor becomes the identity and u0's turn
  // is skipped from then on.
  const preserveOther = actionOf(
    twoCards.actions,
    (action) => action.type === 'preserve' && action.cardId !== monitorId,
  );
  assert.equal(harness.match.act('u0', preserveOther).ok, true);

  const oneCard = lastGameView(harness.sent, 'u0').view;
  assert.equal(oneCard.you?.hand.length, 1);
  assert.equal(oneCard.you?.hand[0]?.id, monitorId);
  assert.equal(oneCard.you?.identity?.id, monitorId);
  assert.equal(lastGameView(harness.sent, 'u0').actions.length, 0);
  assert.notEqual(oneCard.turn?.playerId, 'u0');

  driveToFinish(harness, monitorId);
  const finished = lastGameView(harness.sent, 'u0').view;
  assert.equal(finished.phase, 'finished');
  assert.equal(finished.status, 'finished');
  assert.ok(finished.result);
  assert.equal(finished.result?.identities.find((entry) => entry.userId === 'u0')?.card?.id, monitorId);
  assert.equal(finished.players.every((player) => player.identity !== undefined), true);
  assert.equal(finished.result?.reveal.hands.length, 3);
  assert.equal(finished.result?.reveal.preservation.length, finished.result?.preservation.cards.length ?? 0);
});

test('ice: a completed preserve-only game emits one result with userId winners and stats-friendly payload', () => {
  const harness = setup(4, [['president'], [], [], []]);
  harness.start();
  driveToFinish(harness);

  const results = harness.sent.filter((message) => message.t === 'result');
  assert.equal(results.length, 1);
  const result = results[0] as Extract<GameToPlatform, { t: 'result' }>;
  const payload = result.result as { winners: string[]; status: string; success: boolean };
  assert.ok(Array.isArray(payload.winners));
  assert.equal(payload.winners.every((id) => typeof id === 'string'), true);
  assert.equal(payload.winners.every((id) => ['u0', 'u1', 'u2', 'u3'].includes(id)), true);
  assert.equal(typeof payload.success, 'boolean');
  assert.ok(['won', 'lost'].includes(payload.status));

  const view = lastGameView(harness.sent, 'u1').view;
  assert.equal(view.phase, 'finished');
  assert.deepEqual(view.piles.preservation.cards?.length, view.result?.preservation.cards.length);
  assert.equal(view.result?.outcomes.length, 4);
  assert.equal(view.result?.identities.length, 4);
  assert.equal(
    view.result?.reveal.accusations.reduce((sum, pile) => sum + pile.cards.length, 0),
    view.piles.accusations.reduce((sum, pile) => sum + pile.count, 0),
  );

  const late = harness.match.act('u0', { type: 'preserve', cardId: 'x' });
  assert.equal(late.ok, false);
  assert.equal(late.code, 'E_GAME_OVER');
});

test('ice: reconnect resends the current private view', () => {
  const harness = setup(3, [['president'], [], []]);
  harness.start();
  const before = handOf(harness.sent, 'u0');
  harness.match.setConnected('u0', false);
  assert.equal(lastGameView(harness.sent, 'u1').view.players[0]?.connected, false);
  harness.match.setConnected('u0', true);
  const after = handOf(harness.sent, 'u0');
  assert.deepEqual(after, before);
  assert.equal(lastGameView(harness.sent, 'u1').view.players[0]?.connected, true);
});

test('ice: stale choice ids are rejected and the valid one still works', () => {
  const harness = setup(3, [['president', 'health'], [], []]);
  harness.start();
  const healthId = cardId(lastGameView(harness.sent, 'u0').view, 'health');
  const use = actionOf(
    lastGameView(harness.sent, 'u0').actions,
    (action) => action.type === 'use' && action.cardId === healthId,
  );
  assert.equal(harness.match.act('u0', use).ok, true);

  const pending = lastGameView(harness.sent, 'u0').view.you!.pending!;
  const stale = harness.match.act('u0', {
    type: 'resolve',
    choiceId: 'not-the-current-choice',
    cardId: healthId,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'E_STALE_CHOICE');

  const valid = harness.match.act('u0', {
    type: 'resolve',
    choiceId: pending.choiceId,
    cardId: healthId,
  });
  assert.equal(valid.ok, true);
});

test('ice: 4, 5 and 6 player matches deal the right hand size and start with the president', () => {
  for (const playerCount of [4, 5, 6] as const) {
    const seeds: CardKey[][] = Array.from({ length: playerCount }, () => []);
    seeds[0] = ['president'];
    const harness = setup(playerCount, seeds);
    harness.start();

    const view = lastGameView(harness.sent, 'u0').view;
    assert.equal(view.config.playerCount, playerCount);
    assert.equal(view.config.startingHandSize, startingHandSize(playerCount));
    assert.equal(view.you?.hand.length, startingHandSize(playerCount));
    assert.equal(view.players.length, playerCount);
    assert.equal(view.turn?.playerId, 'u0');
    assert.equal(view.config.preservationThreshold, { 4: 8, 5: 7, 6: 6 }[playerCount]);
    assert.equal(
      harness.seats.every((seat) =>
        lastGameView(harness.sent, seat.userId).view.players.every(
          (player) => player.handCount === startingHandSize(playerCount),
        ),
      ),
      true,
    );
  }
});

test('ice: targeted effects can also be driven through a choose-player pending', () => {
  const harness = setup(3, [['president', 'discipline'], ['monitor'], []]);
  harness.start();
  const disciplineId = cardId(lastGameView(harness.sent, 'u0').view, 'discipline');

  // The concrete action list normally includes a target, but a generic use
  // without a target must also open a prompt.
  assert.equal(harness.match.act('u0', { type: 'use', cardId: disciplineId }).ok, true);
  const pending = lastGameView(harness.sent, 'u0').view.you?.pending;
  assert.equal(pending?.kind, 'choose-player');
  assert.deepEqual(
    pending?.candidates?.map((candidate) => candidate.userId),
    ['u1', 'u2'],
  );

  const choose = actionOf(
    lastGameView(harness.sent, 'u0').actions,
    (action) => action.type === 'resolve' && action.targetPlayerId === 'u1',
  );
  assert.equal(harness.match.act('u0', choose).ok, true);
  const peek = lastGameView(harness.sent, 'u0').view.you?.pending;
  assert.equal(peek?.kind, 'peek');
  assert.equal(peek?.source, 'hand');
  assert.ok(peek?.cards?.some((card) => card.key === 'monitor'));
});

test('ice: an abandoned simultaneous choice auto-resolves after the timeout', async () => {
  const harness = setup(3, [['president', 'monitor'], ['honors'], []], {
    pendingTimeoutMs: 80,
  });
  harness.start();
  const monitorId = cardId(lastGameView(harness.sent, 'u0').view, 'monitor');
  const use = actionOf(
    lastGameView(harness.sent, 'u0').actions,
    (action) =>
      action.type === 'use' && action.cardId === monitorId && action.targetPlayerId === 'u1',
  );
  assert.equal(harness.match.act('u0', use).ok, true);
  assert.equal(lastGameView(harness.sent, 'u0').view.you?.pending?.kind, 'simultaneous');

  await new Promise((resolve) => setTimeout(resolve, 250));

  const after = lastGameView(harness.sent, 'u0').view;
  assert.equal(after.pending, null);
  assert.equal(after.turn?.playerId, 'u1');
  assert.equal(after.you?.hand.length, 5);
  assert.equal(lastGameView(harness.sent, 'u1').view.you?.hand.length, 6);
});

test('ice: a player cannot accuse themself (the accomplice remains the way to move cards to self)', () => {
  const harness = setup(3, [['president'], [], []]);
  harness.start();
  const actions = lastGameView(harness.sent, 'u0').actions;
  assert.equal(
    actions.some((action) => action.type === 'accuse' && action.targetPlayerId === 'u0'),
    false,
  );

  const card = lastGameView(harness.sent, 'u0').view.you!.hand[0]!;
  const rejected = harness.match.act('u0', {
    type: 'accuse',
    cardId: card.id,
    targetPlayerId: 'u0',
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error ?? '', /自己/);

  const after = lastGameView(harness.sent, 'u0').view;
  assert.equal(after.turn?.playerId, 'u0');
  assert.equal(after.you?.hand.length, 6);
  assert.equal(after.players[0]?.accusationCount, 0);
});

test('ice: news club lets a one-card player receive without giving', () => {
  const harness = setup(3, [['president', 'news', 'health'], [], []]);
  harness.start();
  const healthId = cardId(lastGameView(harness.sent, 'u0').view, 'health');

  // Keep u0 at six cards with repeated 保健委员 re-takes while the other two
  // players preserve down to one card.
  for (let cycle = 0; cycle < 5; cycle += 1) {
    assert.equal(lastGameView(harness.sent, 'u0').view.turn?.playerId, 'u0');
    const useHealth = actionOf(
      lastGameView(harness.sent, 'u0').actions,
      (action) => action.type === 'use' && action.cardId === healthId,
    );
    assert.equal(harness.match.act('u0', useHealth).ok, true);
    const takeBack = actionOf(
      lastGameView(harness.sent, 'u0').actions,
      (action) => action.type === 'resolve' && action.cardId === healthId,
    );
    assert.equal(harness.match.act('u0', takeBack).ok, true);
    preserveFor(harness, 'u1');
    preserveFor(harness, 'u2');
  }

  const before = lastGameView(harness.sent, 'u0').view;
  assert.equal(before.you?.hand.length, 6);
  assert.equal(before.players[1]?.handCount, 1);
  assert.equal(before.players[2]?.handCount, 1);
  assert.equal(before.turn?.playerId, 'u0');

  const newsId = cardId(before, 'news');
  const giveId = before.you!.hand.find(
    (card) => card.id !== newsId && card.id !== healthId,
  )?.id;
  assert.ok(giveId);

  const useNews = actionOf(
    lastGameView(harness.sent, 'u0').actions,
    (action) => action.type === 'use' && action.cardId === newsId,
  );
  assert.equal(harness.match.act('u0', useNews).ok, true);

  const pending = lastGameView(harness.sent, 'u0').view.you?.pending;
  assert.equal(pending?.kind, 'simultaneous');
  assert.deepEqual(pending?.participants, ['u0']);
  assert.equal(pending?.options?.some((card) => card.id === giveId), true);

  assert.equal(
    harness.match.act('u0', {
      type: 'resolve',
      choiceId: pending!.choiceId,
      cardId: giveId,
    }).ok,
    true,
  );

  const after = lastGameView(harness.sent, 'u0').view;
  assert.equal(after.you?.hand.length, 4);
  assert.equal(after.players[1]?.handCount, 1);
  assert.equal(after.players[2]?.handCount, 2); // u0's 上家 receives
  assert.equal(after.turn?.playerId, 'u2');
  assert.equal(
    lastGameView(harness.sent, 'u2').view.you?.hand.some((card) => card.id === giveId),
    true,
  );
  assert.equal(
    lastGameView(harness.sent, 'u1').view.you?.hand.some((card) => card.id === giveId),
    false,
  );
});

test('ice: infected still resolves at the next turn when its owner is down to one card', () => {
  const harness = setup(3, [
    ['president', 'infected', 'alien', 'honors', 'library', 'health'],
    [],
    [],
  ]);
  harness.start();
  const infectedId = cardId(lastGameView(harness.sent, 'u0').view, 'infected');

  // Preserve four non-infected cards; the infected card stays for the fifth turn.
  for (let cycle = 0; cycle < 4; cycle += 1) {
    assert.equal(lastGameView(harness.sent, 'u0').view.turn?.playerId, 'u0');
    preserveFor(harness, 'u0', infectedId);
    preserveFor(harness, 'u1');
    preserveFor(harness, 'u2');
  }

  let u0 = lastGameView(harness.sent, 'u0');
  assert.deepEqual(
    u0.view.you?.hand.map((card) => card.key),
    ['infected', 'health'],
  );
  const useInfected = actionOf(
    u0.actions,
    (action) => action.type === 'use' && action.cardId === infectedId,
  );
  assert.equal(harness.match.act('u0', useInfected).ok, true);

  u0 = lastGameView(harness.sent, 'u0');
  assert.equal(u0.view.you?.hand.length, 1);
  assert.equal(u0.view.players[0]?.front[0]?.id, infectedId);
  assert.equal(u0.view.turn?.playerId, 'u1');

  preserveFor(harness, 'u1');
  preserveFor(harness, 'u2');

  const pending = lastGameView(harness.sent, 'u0').view.you?.pending;
  assert.equal(pending?.kind, 'choose-card');
  assert.equal(pending?.purpose, 'infection');
  const choose = actionOf(
    lastGameView(harness.sent, 'u0').actions,
    (action) => action.type === 'resolve' && action.index === 0,
  );
  assert.equal(harness.match.act('u0', choose).ok, true);

  u0 = lastGameView(harness.sent, 'u0');
  assert.equal(u0.view.you?.hand.length, 2);
  assert.equal(u0.view.players[0]?.front.length, 0);
  assert.equal(u0.view.piles.discard.cards.some((card) => card.id === infectedId), true);
  assert.equal(u0.view.turn?.playerId, 'u0');
  assert.ok(u0.actions.length > 0);
});

test('ice: every turn is auto-played when the decision timeout expires', async () => {
  const harness = setup(
    3,
    [['president', 'alien', 'discipline', 'library', 'honors', 'infected'], [], []],
    { turnTimeoutMs: 60 },
  );
  harness.start();
  const startSeq = lastGameView(harness.sent, 'u0').seq;

  await waitUntil(
    () =>
      lastGameView(harness.sent, 'u0').view.log.some((entry) =>
        entry.text.includes('决策超时'),
      ),
    3000,
  );
  harness.match.abort();

  const after = lastGameView(harness.sent, 'u0').view;
  assert.ok(after.log.some((entry) => entry.text.includes('系统随机执行')));
  assert.ok(lastGameView(harness.sent, 'u0').seq > startSeq);
  assert.equal(after.turn?.playerId, 'u1');
  assert.equal(after.you?.hand.length, 5);
});

test('ice: a single-actor pending is auto-resolved at the decision timeout', async () => {
  const harness = setup(3, [['president', 'health'], [], []], {
    pendingTimeoutMs: 60,
  });
  harness.start();
  const healthId = cardId(lastGameView(harness.sent, 'u0').view, 'health');
  assert.equal(harness.match.act('u0', useAction(harness, 'u0', healthId)).ok, true);
  assert.equal(
    lastGameView(harness.sent, 'u0').view.you?.pending?.kind,
    'choose-card',
  );

  await waitUntil(
    () => lastGameView(harness.sent, 'u0').view.you?.pending === null,
    3000,
  );

  const after = lastGameView(harness.sent, 'u0').view;
  assert.equal(after.you?.hand.length, 6);
  assert.equal(after.piles.discard.count, 0);
  assert.equal(after.turn?.playerId, 'u1');
  assert.ok(after.log.some((entry) => entry.text.includes('决策超时')));
});

test('ice: chaos allows 班长/新闻部/归宅部 at two cards, standard does not', () => {
  for (const key of ['monitor', 'news', 'homebody'] as const) {
    const makeSeeds = (): CardKey[][] => [
      ['president', key, 'health', 'library', 'alien', 'discipline'],
      [],
      [],
    ];

    const standard = setup(3, makeSeeds(), { mode: 'standard' });
    const chaos = setup(3, makeSeeds(), { mode: 'chaos' });
    standard.start();
    chaos.start();

    const standardId = cardId(lastGameView(standard.sent, 'u0').view, key);
    const chaosId = cardId(lastGameView(chaos.sent, 'u0').view, key);
    driveAllToTwo(standard, standardId);
    driveAllToTwo(chaos, chaosId);

    const standardActions = lastGameView(standard.sent, 'u0').actions;
    assert.equal(
      standardActions.some(
        (action) => action.type === 'use' && 'cardId' in action && action.cardId === standardId,
      ),
      false,
      `standard should not offer ${key} at two cards`,
    );

    const chaosActions = lastGameView(chaos.sent, 'u0').actions;
    assert.equal(
      chaosActions.some(
        (action) => action.type === 'use' && 'cardId' in action && action.cardId === chaosId,
      ),
      true,
      `chaos should offer ${key} at two cards`,
    );

    if (key === 'monitor') {
      const use = useAction(chaos, 'u0', chaosId, 'u1');
      assert.equal(chaos.match.act('u0', use).ok, true);
      const exchange = lastGameView(chaos.sent, 'u0').view.you?.pending;
      assert.equal(exchange?.kind, 'simultaneous');
      const targetPending = lastGameView(chaos.sent, 'u1').view.you?.pending;
      assert.equal(targetPending?.options?.length, 2);
      // u0 now has one card; in chaos it may give its last card.
      const u0Card = lastGameView(chaos.sent, 'u0').view.you!.hand[0]!;
      const u1Card = lastGameView(chaos.sent, 'u1').view.you!.hand[0]!;
      assert.equal(
        chaos.match.act('u0', {
          type: 'resolve',
          choiceId: exchange!.choiceId,
          cardId: u0Card.id,
        }).ok,
        true,
      );
      assert.equal(
        chaos.match.act('u1', {
          type: 'resolve',
          choiceId: exchange!.choiceId,
          cardId: u1Card.id,
        }).ok,
        true,
      );
      assert.equal(lastGameView(chaos.sent, 'u0').view.you?.hand.length, 1);
      assert.equal(lastGameView(chaos.sent, 'u1').view.you?.hand.length, 2);
    }

    if (key === 'news') {
      const use = useAction(chaos, 'u0', chaosId);
      assert.equal(chaos.match.act('u0', use).ok, true);
      const pending = lastGameView(chaos.sent, 'u0').view.you?.pending;
      assert.equal(pending?.kind, 'simultaneous');
      assert.deepEqual(pending?.participants, ['u0', 'u1', 'u2']);
      const cards = new Map<string, string>();
      for (const userId of ['u0', 'u1', 'u2']) {
        cards.set(userId, lastGameView(chaos.sent, userId).view.you!.hand[0]!.id);
      }
      for (const userId of ['u0', 'u1', 'u2']) {
        assert.equal(
          chaos.match.act(userId, {
            type: 'resolve',
            choiceId: pending!.choiceId,
            cardId: cards.get(userId)!,
          }).ok,
          true,
        );
      }
      assert.equal(lastGameView(chaos.sent, 'u0').view.you?.hand.length, 1);
      assert.equal(lastGameView(chaos.sent, 'u1').view.you?.hand.length, 2);
      assert.equal(lastGameView(chaos.sent, 'u2').view.you?.hand.length, 2);
    }

    if (key === 'homebody') {
      const use = useAction(chaos, 'u0', chaosId);
      assert.equal(chaos.match.act('u0', use).ok, true);
      const pick = lastGameView(chaos.sent, 'u0').view.you?.pending;
      assert.equal(pick?.kind, 'choose-card');
      assert.equal(pick?.from, 'preservation');
      const choosePreserve = actionOf(
        lastGameView(chaos.sent, 'u0').actions,
        (action) => action.type === 'resolve' && action.index === 0,
      );
      assert.equal(chaos.match.act('u0', choosePreserve).ok, true);
      const give = lastGameView(chaos.sent, 'u0').view.you?.pending;
      assert.equal(give?.kind, 'choose-card');
      assert.equal(give?.from, 'hand');
      assert.equal(give?.count, 1);
      const lastCard = lastGameView(chaos.sent, 'u0').view.you!.hand[0]!;
      assert.equal(
        chaos.match.act('u0', {
          type: 'resolve',
          choiceId: give!.choiceId,
          cardId: lastCard.id,
        }).ok,
        true,
      );
      assert.equal(lastGameView(chaos.sent, 'u0').view.you?.hand.length, 1);
    }
  }
});

test('ice: chaos allows 班长/大小姐 to target a one-card hand, standard does not', () => {
  for (const key of ['monitor', 'ojou'] as const) {
    const makeSeeds = (): CardKey[][] => [
      ['president', key, 'health'],
      [],
      [],
    ];

    const standard = setup(3, makeSeeds(), { mode: 'standard' });
    const chaos = setup(3, makeSeeds(), { mode: 'chaos' });
    standard.start();
    chaos.start();
    driveOthersToOne(standard);
    driveOthersToOne(chaos);

    const standardId = cardId(lastGameView(standard.sent, 'u0').view, key);
    const chaosId = cardId(lastGameView(chaos.sent, 'u0').view, key);
    const standardActions = lastGameView(standard.sent, 'u0').actions;
    assert.equal(
      standardActions.some(
        (action) => action.type === 'use' && 'cardId' in action && action.cardId === standardId,
      ),
      false,
      `standard should not target a one-card hand with ${key}`,
    );

    const chaosActions = lastGameView(chaos.sent, 'u0').actions;
    const chaosUse = actionOf(
      chaosActions,
      (action) =>
        action.type === 'use' &&
        action.cardId === chaosId &&
        action.targetPlayerId === 'u1',
    );

    if (key === 'ojou') {
      assert.equal(chaos.match.act('u0', chaosUse).ok, true);
      const targetView = lastGameView(chaos.sent, 'u1').view;
      assert.equal(targetView.players[1]?.handCount, 0);
      assert.equal(targetView.you?.hand.length, 0);
      assert.equal(targetView.you?.identity, null);

      const give = lastGameView(chaos.sent, 'u0').view.you?.pending;
      assert.equal(give?.kind, 'choose-card');
      assert.equal(give?.from, 'hand');
      const giveCard = lastGameView(chaos.sent, 'u0').view.you!.hand[0]!;
      assert.equal(
        chaos.match.act('u0', {
          type: 'resolve',
          choiceId: give!.choiceId,
          cardId: giveCard.id,
        }).ok,
        true,
      );
      assert.equal(lastGameView(chaos.sent, 'u1').view.you?.hand.length, 1);
      assert.equal(lastGameView(chaos.sent, 'u1').view.players[1]?.handCount, 1);
    }

    if (key === 'monitor') {
      assert.equal(chaos.match.act('u0', chaosUse).ok, true);
      const pending = lastGameView(chaos.sent, 'u0').view.you?.pending;
      assert.equal(pending?.kind, 'simultaneous');
      const targetPending = lastGameView(chaos.sent, 'u1').view.you?.pending;
      assert.deepEqual(targetPending?.options?.length, 1);
      const u0Card = lastGameView(chaos.sent, 'u0').view.you!.hand[0]!;
      const u1Card = lastGameView(chaos.sent, 'u1').view.you!.hand[0]!;
      assert.equal(
        chaos.match.act('u0', {
          type: 'resolve',
          choiceId: pending!.choiceId,
          cardId: u0Card.id,
        }).ok,
        true,
      );
      assert.equal(
        chaos.match.act('u1', {
          type: 'resolve',
          choiceId: pending!.choiceId,
          cardId: u1Card.id,
        }).ok,
        true,
      );
      assert.equal(lastGameView(chaos.sent, 'u0').view.you?.hand.length, 5);
      assert.equal(lastGameView(chaos.sent, 'u1').view.you?.hand.length, 1);
    }
  }
});

test('ice: chaos news requires one-card players to give, standard does not', () => {
  const makeSeeds = (): CardKey[][] => [['president', 'news', 'health'], [], []];
  const standard = setup(3, makeSeeds(), { mode: 'standard' });
  const chaos = setup(3, makeSeeds(), { mode: 'chaos' });
  standard.start();
  chaos.start();
  driveOthersToOne(standard);
  driveOthersToOne(chaos);

  const standardNews = cardId(lastGameView(standard.sent, 'u0').view, 'news');
  const standardUse = useAction(standard, 'u0', standardNews);
  assert.equal(standard.match.act('u0', standardUse).ok, true);
  const standardPending = lastGameView(standard.sent, 'u0').view.you?.pending;
  assert.equal(standardPending?.kind, 'simultaneous');
  assert.deepEqual(standardPending?.participants, ['u0']);

  const chaosNews = cardId(lastGameView(chaos.sent, 'u0').view, 'news');
  const chaosUse = useAction(chaos, 'u0', chaosNews);
  assert.equal(chaos.match.act('u0', chaosUse).ok, true);
  const chaosPending = lastGameView(chaos.sent, 'u0').view.you?.pending;
  assert.equal(chaosPending?.kind, 'simultaneous');
  assert.deepEqual(chaosPending?.participants, ['u0', 'u1', 'u2']);
  assert.equal(lastGameView(chaos.sent, 'u1').view.you?.pending?.options?.length, 1);
  assert.equal(lastGameView(chaos.sent, 'u2').view.you?.pending?.options?.length, 1);
  // One-card participants still need a server-provided resolve action in chaos.
  assert.equal(lastGameView(chaos.sent, 'u1').actions.length, 1);
  assert.equal(lastGameView(chaos.sent, 'u2').actions.length, 1);

  const u0Card = lastGameView(chaos.sent, 'u0').view.you!.hand[0]!;
  const u1Card = lastGameView(chaos.sent, 'u1').view.you!.hand[0]!;
  const u2Card = lastGameView(chaos.sent, 'u2').view.you!.hand[0]!;
  for (const [userId, cardId] of [
    ['u0', u0Card.id],
    ['u1', u1Card.id],
    ['u2', u2Card.id],
  ] as const) {
    assert.equal(
      chaos.match.act(userId, {
        type: 'resolve',
        choiceId: chaosPending!.choiceId,
        cardId,
      }).ok,
      true,
    );
  }

  // u0 -> u2, u1 -> u0, u2 -> u1; one-card givers temporarily reach zero and
  // receive one card, ending at one again.
  assert.equal(lastGameView(chaos.sent, 'u0').view.you?.hand.length, 5);
  assert.equal(lastGameView(chaos.sent, 'u1').view.you?.hand.length, 1);
  assert.equal(lastGameView(chaos.sent, 'u2').view.you?.hand.length, 1);
  assert.equal(
    lastGameView(chaos.sent, 'u0').view.you?.hand.some((card) => card.id === u1Card.id),
    true,
  );
  assert.equal(
    lastGameView(chaos.sent, 'u1').view.you?.hand.some((card) => card.id === u2Card.id),
    true,
  );
  assert.equal(
    lastGameView(chaos.sent, 'u2').view.you?.hand.some((card) => card.id === u0Card.id),
    true,
  );
});

test('ice: the worker rejects an action carrying a stale seq (auto-action race)', () => {
  const harness = setup(3, [['president'], [], []]);
  harness.start();
  const view = lastGameView(harness.sent, 'u0').view;
  const card = view.you!.hand[0]!;
  harness.match.handle({
    v: 1,
    t: 'action',
    matchId: 'match-1',
    playerId: 'u0',
    seq: 999,
    actionId: 'stale',
    action: { type: 'preserve', cardId: card.id },
  });

  const error = harness.sent.filter((message) => message.t === 'error').at(-1) as
    | { code?: string }
    | undefined;
  assert.equal(error?.code, 'E_STALE');
  assert.equal(lastGameView(harness.sent, 'u0').view.turn?.playerId, 'u0');
  assert.equal(lastGameView(harness.sent, 'u0').view.you?.hand.length, 6);
});
