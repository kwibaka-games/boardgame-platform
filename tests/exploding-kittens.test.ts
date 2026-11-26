import assert from 'node:assert/strict';
import test from 'node:test';
import type { Card, CardKind, DeckCard } from '../src/games/exploding-kittens-kwdbd/cards.js';
import { ExplodingKittensMatch } from '../src/games/exploding-kittens-kwdbd/game.js';
import type { GameToPlatform, Seat } from '../src/protocol/protocol.js';

type View = {
  status: string;
  turn: string | null;
  direction: number | null;
  remaining: number;
  attacks: number;
  collar: string | null;
  choice?: { type: string; actorId: string };
  response?: { vetoed: boolean };
  you: { hand: Card[]; peek: CardKind[] } | null;
  players: { userId: string; handCount: number; alive: boolean }[];
  faceUpHoles: number;
  discard: Card[];
  winners: string[];
};

function table(count = 3, responseMs?: number, rolls: number[] = []) {
  const seats: Seat[] = ['a', 'b', 'c', 'd', 'e'].slice(0, count).map((userId, seat) => ({ userId, name: userId, seat }));
  const views = new Map<string, { seq: number; view: View }>();
  const messages: GameToPlatform[] = [];
  const game = new ExplodingKittensMatch((message) => {
    messages.push(message);
    if (message.t === 'view') views.set(message.to, { seq: message.seq, view: message.view as View });
  }, () => rolls.shift() ?? 0, responseMs);
  game.handle({ v: 1, t: 'match.create', matchId: 'm', gameId: 'exploding-kittens', seats: [...seats].reverse(), settings: {} });
  for (const { userId } of seats) game.handle({ v: 1, t: 'player.ready', matchId: 'm', playerId: userId });

  const view = (userId?: string) => views.get(userId ? `player:${userId}` : 'spectator')!.view;
  function action(playerId: string, action: unknown, seq = views.get('spectator')!.seq) {
    game.handle({ v: 1, t: 'action', matchId: 'm', playerId, seq, actionId: String(messages.length), action });
  }
  function settle() {
    for (const player of view().players) {
      if (player.alive && view().response) action(player.userId, { type: 'pass' });
    }
    assert.ok(!view().response);
  }
  function doAction(playerId: string, input: unknown) {
    action(playerId, input);
    assert.notEqual(messages.at(-1)?.t, 'error');
    settle();
  }
  // Seed the private zones to exercise known draws without bypassing action validation.
  const { match } = game as unknown as {
    match: { players: { userId: string; hand: Card[] }[]; deck: DeckCard[]; discard: Card[] };
  };
  let nextId = 1000;
  const cards = (kinds: CardKind[]) => kinds.map((kind) => ({ id: nextId++, kind }));
  function hand(playerId: string, ...kinds: CardKind[]) {
    const player = match.players.find(({ userId }) => userId === playerId)!;
    player.hand = cards(kinds);
    return player.hand.map(({ id }) => id);
  }
  function deck(...kinds: CardKind[]) { match.deck = cards(kinds); }
  function discard(...kinds: CardKind[]) {
    match.discard = cards(kinds);
    return match.discard.map(({ id }) => id);
  }
  const play = (cardId: number, targetId?: string, playerId = 'a') => doAction(playerId, { type: 'play', cardId, targetId });
  const draw = (playerId: string) => doAction(playerId, { type: 'draw' });
  return { action, view, doAction, messages, settle, hand, deck, discard, play, draw };
}

test('setup deals private hands and independently rolls the direction and first seat', () => {
  const players = ['a', 'b', 'c', 'd', 'e'];
  for (const count of [2, 3, 4, 5]) {
    for (const [direction, roll] of [[1, 0], [-1, 0.9]]) {
      const game = table(count, undefined, [roll!, 0.99]);
      const starter = players[count - 1]!;
      assert.equal(game.view().turn, starter);
      assert.equal(game.view().direction, direction);
      assert.equal(game.view().choice, undefined);
      assert.equal(game.view().players.length, count);
      assert.ok(game.view().players.every((player) => player.handCount === 6 && !('hand' in player)));
      assert.equal(game.view().you, null);
      assert.equal(game.view(starter).you!.hand.filter(({ kind }) => kind === 'defuse').length, 1);
      assert.ok(game.view(starter).you!.hand.every(({ kind }) => kind !== 'cat' && kind !== 'hole'));
      game.deck('oracle');
      game.draw(starter);
      assert.equal(game.view().turn, direction === 1 ? players[0] : players[count - 2]);
    }
  }
});

test('defuse stays private; the next draw can explode and discard the eliminated hand', () => {
  const game = table(2);
  game.hand('a', 'defuse');
  const [skip] = game.hand('b', 'skip');
  game.deck('cat', 'future');
  game.draw('a');
  assert.deepEqual(game.view().choice, { type: 'defuse', actorId: 'a' });
  game.action('b', { type: 'nope', cardId: skip });
  assert.equal(game.messages.at(-1)?.t, 'error');
  game.doAction('a', { type: 'defuse', position: 0 });
  assert.equal(game.view().turn, 'b');
  assert.deepEqual(game.view().discard.map(({ kind }) => kind), ['defuse']);
  assert.ok(!('deck' in game.view()));
  game.draw('b');
  assert.deepEqual(game.view().discard.map(({ kind }) => kind), ['defuse', 'skip', 'cat']);
  assert.equal(game.view('b').you!.hand.length, 0);
  assert.deepEqual(game.view().winners, ['a']);
  assert.equal(game.messages.filter(({ t }) => t === 'result').length, 1);
});

test('a revealed black hole stays in the deck until drawn again and ignores defuse', () => {
  const game = table();
  game.hand('b', 'defuse', 'attack');
  game.deck('hole', 'oracle');
  game.draw('a');
  assert.equal(game.view().choice?.type, 'insert-hole');
  game.action('a', { type: 'insert-hole', position: 2 });
  assert.equal(game.messages.at(-1)?.t, 'error');
  game.doAction('a', { type: 'insert-hole', position: 0 });
  assert.equal(game.view().faceUpHoles, 1);
  game.draw('b');
  assert.equal(game.view().players[1]!.alive, false);
  assert.equal(game.view().turn, 'c');
  assert.equal(game.view().faceUpHoles, 0);
  assert.deepEqual(game.view().discard.map(({ kind }) => kind), ['defuse', 'attack', 'hole']);
});

test('Nope chains alternate the result and clear prior passes', () => {
  const game = table();
  const [oracle, future, nopeA] = game.hand('a', 'oracle', 'future', 'nope');
  const [nopeB, nopeB2] = game.hand('b', 'nope', 'nope');
  game.deck('cat', 'skip', 'reverse', 'favor');
  game.action('a', { type: 'play', cardId: oracle });
  game.action('c', { type: 'pass' });
  game.action('b', { type: 'nope', cardId: nopeB });
  assert.equal(game.view().response!.vetoed, true);
  game.action('a', { type: 'pass' });
  game.action('b', { type: 'pass' });
  assert.ok(game.view().response, 'c must pass again');
  game.action('a', { type: 'nope', cardId: nopeA });
  assert.equal(game.view().response!.vetoed, false);
  game.settle();
  assert.deepEqual(game.view('a').you!.peek, ['cat', 'skip', 'reverse']);
  assert.deepEqual(game.view('b').you!.peek, []);

  game.action('a', { type: 'play', cardId: future });
  game.action('b', { type: 'nope', cardId: nopeB2 });
  game.settle();
  assert.deepEqual(game.view().discard.map(({ kind }) => kind), ['oracle', 'nope', 'nope', 'future', 'nope']);
  game.draw('a');
  assert.equal(game.view().players[0]!.alive, false, 'peek did not change the deck order');
});

test('a response also settles on the timeout', async () => {
  const game = table(2, 20);
  game.deck('oracle');
  game.action('a', { type: 'draw' });
  assert.ok(game.view().response);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(game.view().turn, 'b');
  assert.equal(game.view().response, undefined);
});

test('shuffle changes the next draw and Future still reads the top three privately', () => {
  const game = table();
  const [shuffle, future] = game.hand('a', 'shuffle', 'future');
  game.deck('cat', 'skip', 'reverse');
  game.play(shuffle!);
  game.play(future!);
  assert.deepEqual(game.view('a').you!.peek, ['skip', 'reverse', 'cat']);
  assert.deepEqual(game.view('b').you!.peek, []);
  game.draw('a');
  assert.deepEqual(game.view('a').you!.hand.map(({ kind }) => kind), ['skip']);
});

test('mixed attacks stack, and skip, reverse, and bottom draw each settle one turn', () => {
  const game = table();
  const [attack, target] = game.hand('a', 'attack', 'target');
  const [skip, bottom, reverse] = game.hand('c', 'skip', 'bottom', 'reverse');
  game.deck('oracle', 'shuffle', 'favor');
  game.play(attack!);
  game.play(target!, 'c');
  assert.equal(game.view().attacks, 2);
  game.doAction('a', { type: 'finish-attack' });
  assert.equal(game.view().turn, 'c');
  assert.equal(game.view().remaining, 3);
  game.play(skip!, undefined, 'c');
  assert.equal(game.view().remaining, 2);
  game.play(bottom!, undefined, 'c');
  assert.equal(game.view().remaining, 1);
  assert.deepEqual(game.view('c').you!.hand.map(({ kind }) => kind), ['reverse', 'favor']);
  game.play(reverse!, undefined, 'c');
  assert.equal(game.view().direction, -1);
  assert.equal(game.view().turn, 'b');
});

test('help transfers the chosen card through a private view', () => {
  const game = table();
  const [favor] = game.hand('a', 'favor');
  const [skip, defuse] = game.hand('b', 'skip', 'defuse');
  game.play(favor!, 'b');
  assert.deepEqual(game.view().choice, { type: 'give', actorId: 'b' });
  game.doAction('b', { type: 'give', cardId: defuse });
  assert.equal(game.view().turn, 'a');
  assert.deepEqual(game.view('a').you!.hand.map(({ id }) => id), [defuse]);
  assert.deepEqual(game.view('b').you!.hand.map(({ id }) => id), [skip]);
  assert.ok(!JSON.stringify(game.view('c')).includes('"id":' + defuse));
});

test('a giver can spend the selected Nope during the response without losing a different card', () => {
  const game = table();
  const [favor, nopeA] = game.hand('a', 'favor', 'nope');
  const [nopeB, skip] = game.hand('b', 'nope', 'skip');
  game.play(favor!, 'b');
  game.action('b', { type: 'give', cardId: nopeB });
  game.action('b', { type: 'nope', cardId: nopeB });
  game.action('a', { type: 'nope', cardId: nopeA });
  game.settle();
  assert.deepEqual(game.view().choice, { type: 'give', actorId: 'b' });
  assert.deepEqual(game.view('b').you!.hand.map(({ id }) => id), [skip]);
  game.doAction('b', { type: 'give', cardId: skip });
  assert.deepEqual(game.view('a').you!.hand.map(({ id }) => id), [skip]);
});

test('three combo shapes transfer cards; duplicated IDs and stale actions are rejected', () => {
  const game = table();
  const ids = game.hand('a', 'skip', 'skip', 'reverse', 'reverse', 'reverse', 'oracle', 'future', 'favor', 'attack', 'nope');
  const [defuse, shuffle, bottom] = game.hand('b', 'defuse', 'shuffle', 'bottom');
  const [recover] = game.discard('cat');
  game.action('a', { type: 'draw' }, 1);
  assert.equal(game.messages.at(-1)?.t, 'error');
  game.action('a', { type: 'combo', cardIds: [ids[0], ids[0]], targetId: 'b' });
  assert.equal(game.messages.at(-1)?.t, 'error');
  game.doAction('a', { type: 'combo', cardIds: ids.slice(0, 2), targetId: 'b' });
  assert.ok(game.view('a').you!.hand.some(({ id }) => id === defuse));
  game.doAction('a', { type: 'combo', cardIds: ids.slice(2, 5), targetId: 'b', wanted: 'bottom' });
  assert.ok(game.view('a').you!.hand.some(({ id }) => id === bottom));
  assert.deepEqual(game.view('b').you!.hand.map(({ id }) => id), [shuffle]);
  game.doAction('a', { type: 'combo', cardIds: ids.slice(5), discardId: recover });
  assert.ok(game.view('a').you!.hand.some(({ id }) => id === recover));
  assert.ok(!game.view().discard.some(({ id }) => id === recover));
});

test('the first out-of-turn play receives the collar, and an empty deck can still end the game', () => {
  const game = table(2);
  const [skip] = game.hand('b', 'skip');
  game.hand('a');
  game.deck();
  game.action('b', { type: 'play', cardId: skip });
  assert.equal(game.view().collar, 'b');
  game.action('a', { type: 'ask-order' });
  assert.equal(game.view().collar, 'b');
  game.draw('a');
  assert.equal(game.view().status, 'finished');
  assert.deepEqual(game.view().winners, ['b']);
});
