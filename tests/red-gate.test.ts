import assert from 'node:assert/strict';
import test from 'node:test';
import { RedGateMatch } from '../src/games/red-gate/game.js';
import { buildDeck } from '../src/games/red-gate/cards.js';
import type { GameToPlatform, PlatformToGame, Seat } from '../src/protocol/protocol.js';

const seats: Seat[] = [
  { userId: 'host', name: 'Host', seat: 0, ready: true },
  { userId: 'guest', name: 'Guest', seat: 1, ready: true },
  { userId: 'third', name: 'Third', seat: 2, ready: true },
];

function start(settings: Record<string, unknown> = {}) {
  const sent: GameToPlatform[] = [];
  const match = new RedGateMatch((message) => sent.push(message), () => 1);
  const create: PlatformToGame = {
    v: 1,
    t: 'match.create',
    matchId: 'r1',
    gameId: 'red-gate',
    seats,
    settings,
  };
  match.handle(create);
  for (const seat of seats) {
    match.handle({ v: 1, t: 'player.ready', matchId: 'r1', playerId: seat.userId });
  }
  return { match, sent };
}

function view(sent: GameToPlatform[], to: string): any {
  for (let i = sent.length - 1; i >= 0; i -= 1) {
    const message = sent[i]!;
    if (message.t === 'view' && message.to === to) return message.view;
  }
  throw new Error(`missing view ${to}`);
}

function doorOf(view: any, type: string): number {
  const card = view.mansion.find((candidate: any) => candidate.type === type);
  assert.ok(card, `door for ${type}`);
  return card.door;
}

test('red gate uses the base deck and host starts', () => {
  const { sent } = start();
  const spectator = view(sent, 'spectator');
  assert.equal(spectator.mansion.length, 17);
  assert.equal(spectator.players.length, 3);
  assert.equal(spectator.turn, 'host');
  assert.equal(spectator.phase, 'playing');
});

test('players cannot see hidden mansion identities; spectators can', () => {
  const { sent } = start();
  const player = view(sent, 'player:host');
  const spectator = view(sent, 'spectator');
  assert.ok(spectator.mansion.every((card: any) => typeof card.type === 'string'));
  assert.ok(player.mansion.every((card: any) => card.type === undefined));
  assert.equal(player.youAreSpectator, false);
});

test('empty room stays in the mansion and advances the turn', () => {
  const { match, sent } = start();
  const spectator = view(sent, 'spectator');
  const door = doorOf(spectator, 'empty-room');
  match.handle({
    v: 1, t: 'action', matchId: 'r1', playerId: 'host', seq: 1, actionId: 'open',
    action: { type: 'open', door },
  });
  const after = view(sent, 'spectator');
  assert.equal(after.turn, 'guest');
  assert.ok(after.mansion.some((card: any) => card.door === door));
  assert.equal(after.mansion.find((card: any) => card.door === door).claim, 'empty');
});

test('killer key turns its holder into a murderer without leaking the role', () => {
  const { match, sent } = start();
  const spectator = view(sent, 'spectator');
  const door = doorOf(spectator, 'killer-key');
  match.handle({
    v: 1, t: 'action', matchId: 'r1', playerId: 'host', seq: 1, actionId: 'open',
    action: { type: 'open', door },
  });
  const own = view(sent, 'player:host');
  const other = view(sent, 'player:guest');
  const spec = view(sent, 'spectator');
  assert.equal(own.you.role, 'murderer');
  assert.equal(own.you.keys[0].actual, 'killer-key');
  assert.equal(other.players.find((player: any) => player.userId === 'host').role, undefined);
  assert.equal(spec.players.find((player: any) => player.userId === 'host').role, 'murderer');
  assert.equal(other.you.role, 'good');
});

test('collecting all four keys clears them, removes the killer key and shuffles', () => {
  const { match, sent } = start();
  const types = ['silver-key', 'silver-key', 'silver-key', 'killer-key'];
  for (const type of types) {
    const spectator = view(sent, 'spectator');
    const currentId = spectator.turn;
    const current = spectator.players.find((player: any) => player.userId === currentId);
    assert.ok(current);
    const door = doorOf(spectator, type);
    match.handle({
      v: 1, t: 'action', matchId: 'r1', playerId: currentId, seq: 1, actionId: 'open',
      action: { type: 'open', door },
    });
  }
  const spec = view(sent, 'spectator');
  assert.ok(spec.players.every((player: any) => player.claimedKeys === 0));
  assert.ok(spec.mansion.some((card: any) => card.type === 'silver-key'));
  assert.equal(spec.mansion.some((card: any) => card.type === 'killer-key'), false);
});

test('guardian key replaces one silver key', () => {
  const deck = buildDeck(['guardian-key']);
  assert.equal(deck.length, 17);
  assert.equal(deck.filter((type) => type === 'silver-key').length, 2);
  assert.equal(deck.filter((type) => type === 'guardian-key').length, 1);
});

test('silent moth sends a platform chat mute', () => {
  const { match, sent } = start({ expansions: ['moth'] });
  const spectator = view(sent, 'spectator');
  const door = doorOf(spectator, 'moth');
  match.handle({
    v: 1, t: 'action', matchId: 'r1', playerId: 'host', seq: 1, actionId: 'open',
    action: { type: 'open', door },
  });
  const policy = sent.findLast((message) => message.t === 'chat.policy');
  assert.ok(policy && policy.t === 'chat.policy');
  assert.deepEqual(policy.mutedUserIds, ['host']);
});

function internal(match: RedGateMatch): any {
  return (match as unknown as { matches: Map<string, any> }).matches.get('r1');
}

function prepareEscape(match: RedGateMatch, types: string[], fakeExit = false) {
  const state = internal(match);
  const host = state.players.find((player: any) => player.userId === 'host');
  const all = [...state.cards.values()];
  for (const type of types) {
    const card = all.find((candidate: any) => candidate.type === type && candidate.location === 'mansion');
    if (!card) throw new Error(`missing ${type}`);
    card.location = 'held';
    card.ownerId = host.userId;
    card.door = null;
    card.claim = 'silver';
    card.revealed = false;
    if (type === 'killer-key') host.role = 'murderer';
  }
  if (fakeExit) {
    const fake = all.find((card: any) => card.type === 'fake-exit');
    fake.location = 'held';
    fake.ownerId = host.userId;
    fake.door = null;
    fake.revealed = true;
  }
  const exit = all.find((card: any) => card.type === 'escape-exit');
  return exit.door;
}

function openExit(match: RedGateMatch, door: number) {
  match.handle({
    v: 1, t: 'action', matchId: 'r1', playerId: 'host', seq: 100, actionId: 'exit',
    action: { type: 'open', door },
  });
  match.handle({
    v: 1, t: 'action', matchId: 'r1', playerId: 'host', seq: 101, actionId: 'escape',
    action: { type: 'choice', choice: 'yes' },
  });
}

test('escape with three silver keys wins for all good players', () => {
  const { match } = start();
  const door = prepareEscape(match, ['silver-key', 'silver-key', 'silver-key']);
  openExit(match, door);
  const state = internal(match);
  assert.equal(state.phase, 'finished');
  assert.equal(state.result.reason, 'escape');
  assert.deepEqual(state.result.winners.sort(), ['guest', 'host', 'third']);
});

test('escape with the killer key kills everyone', () => {
  const { match } = start();
  const door = prepareEscape(match, ['silver-key', 'silver-key', 'killer-key']);
  openExit(match, door);
  const state = internal(match);
  assert.equal(state.phase, 'finished');
  assert.equal(state.result.reason, 'escape_failed');
  assert.deepEqual(state.result.winners, []);
});

test('a fake exit can make a successful escape fail', () => {
  const { match } = start({ expansions: ['fake-exit'] });
  const door = prepareEscape(match, ['silver-key', 'silver-key', 'silver-key'], true);
  openExit(match, door);
  const state = internal(match);
  assert.equal(state.phase, 'finished');
  assert.equal(state.result.reason, 'fake_exit_failed');
  assert.deepEqual(state.result.winners, []);
});
