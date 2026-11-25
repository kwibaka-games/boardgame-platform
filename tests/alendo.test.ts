import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AlendoMatch,
  alendoBoardInfo,
  legalMoves,
} from '../src/games/alendo/game.js';
import type { GameToPlatform, PlatformToGame, Seat } from '../src/protocol/protocol.js';

const seats: Seat[] = [
  { userId: 'host', name: 'Host', seat: 0, ready: true },
  { userId: 'guest', name: 'Guest', seat: 1, ready: true },
];

function createMatch(settings: Record<string, unknown> = { hostUserId: 'host', hostColor: 'black' }) {
  const sent: GameToPlatform[] = [];
  const match = new AlendoMatch((message) => sent.push(message));
  const create: PlatformToGame = {
    v: 1,
    t: 'match.create',
    matchId: 'a1',
    gameId: 'alendo',
    seats,
    settings,
  };
  match.handle(create);
  match.handle({ v: 1, t: 'player.ready', matchId: 'a1', playerId: 'host' });
  match.handle({ v: 1, t: 'player.ready', matchId: 'a1', playerId: 'guest' });
  return { match, sent };
}

function lastView(sent: GameToPlatform[], playerId: string): any {
  for (let i = sent.length - 1; i >= 0; i -= 1) {
    const message = sent[i]!;
    if (message.t === 'view' && message.to === `player:${playerId}`) return message.view;
  }
  throw new Error('view not found');
}

function actions(sent: GameToPlatform[], playerId: string): any[] {
  for (let i = sent.length - 1; i >= 0; i -= 1) {
    const message = sent[i]!;
    if (message.t === 'view' && message.to === `player:${playerId}`) return message.actions ?? [];
  }
  return [];
}

test('alendo board has 96 triangles, six centre pieces and 24 strips', () => {
  const info = alendoBoardInfo();
  assert.equal(info.cells.length, 96);
  assert.equal(info.cells.filter((cell) => cell.up).length, 48);
  assert.equal(info.initial.filter((cell) => cell === 'black').length, 3);
  assert.equal(info.initial.filter((cell) => cell === 'white').length, 3);
  assert.equal(info.lines.length, 24);
  assert.equal(new Set(info.lines.flat()).size, 96);
  assert.equal(info.lines.every((line) => line.length >= 9), true);
  assert.equal(legalMoves(info.initial, 'black').length, 3);
  assert.equal(legalMoves(info.initial, 'white').length, 3);
});

test('alendo host color assigns the guest the opposite color', () => {
  const { sent } = createMatch({ hostUserId: 'host', hostColor: 'white' });
  const host = lastView(sent, 'host');
  const guest = lastView(sent, 'guest');
  assert.equal(host.you.color, 'white');
  assert.equal(guest.you.color, 'black');
  assert.equal(host.turn, 'black');
  assert.equal(actions(sent, 'guest').filter((action) => action.type === 'place').length, 3);
  assert.equal(actions(sent, 'host').filter((action) => action.type === 'place').length, 0);
});

test('alendo flips along a triangle strip and switches turns', () => {
  const { match, sent } = createMatch();
  const view = lastView(sent, 'host');
  const move = legalMoves(view.board, 'black')[0]!;
  match.handle({
    v: 1,
    t: 'action',
    matchId: 'a1',
    playerId: 'host',
    seq: 1,
    actionId: 'a1',
    action: { type: 'place', index: move },
  });
  const after = lastView(sent, 'host');
  assert.equal(after.turn, 'white');
  assert.equal(after.counts.black, 5);
  assert.equal(after.counts.white, 2);
});

test('alendo either player can resign', () => {
  const { match, sent } = createMatch();
  match.handle({
    v: 1,
    t: 'action',
    matchId: 'a1',
    playerId: 'guest',
    seq: 1,
    actionId: 'r1',
    action: { type: 'resign' },
  });
  const final = sent.find((message) => message.t === 'result');
  assert.ok(final && final.t === 'result');
  assert.deepEqual((final.result as { winners: string[] }).winners, ['host']);
  assert.equal(lastView(sent, 'host').status, 'finished');
});

test('random alendo games terminate with a consistent 96-cell board', () => {
  for (let game = 0; game < 20; game += 1) {
    const { match, sent } = createMatch({ hostUserId: 'host', hostColor: game % 2 ? 'white' : 'black' });
    for (let step = 0; step < 300; step += 1) {
      const finished = sent.findLast((message) => message.t === 'result');
      if (finished) break;
      const hostActions = actions(sent, 'host');
      const guestActions = actions(sent, 'guest');
      const playerId = hostActions.some((action) => action.type === 'place') ? 'host' : 'guest';
      const legal = (playerId === 'host' ? hostActions : guestActions).filter(
        (action) => action.type === 'place',
      );
      if (legal.length === 0) assert.fail(`alendo game ${game} stuck at step ${step}`);
      const action = legal[(game * 7 + step) % legal.length];
      match.handle({
        v: 1,
        t: 'action',
        matchId: 'a1',
        playerId,
        seq: 1,
        actionId: `a-${game}-${step}`,
        action,
      });
    }
    const result = sent.findLast((message) => message.t === 'result');
    assert.ok(result && result.t === 'result', `game ${game} did not finish`);
    const board = (result.result as { board: (string | null)[] }).board;
    assert.equal(board.length, 96);
  }
});
