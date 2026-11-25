import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GomokuMatch,
  OPENINGS,
  applyOpening,
  boardSize,
  drawOutcome,
  findWin,
  firstTurn,
  forbiddenPoints,
  initialBoard,
} from '../src/games/gomoku/game.js';
import type { GameToPlatform, PlatformToGame, Seat } from '../src/protocol/protocol.js';

const seats: Seat[] = [
  { userId: 'host', name: 'Host', seat: 0, ready: true },
  { userId: 'guest', name: 'Guest', seat: 1, ready: true },
];

function createMatch(mode: 'free' | 'seki' = 'free') {
  const sent: GameToPlatform[] = [];
  const match = new GomokuMatch(mode, (message) => sent.push(message));
  const create: PlatformToGame = {
    v: 1,
    t: 'match.create',
    matchId: 'g1',
    gameId: mode === 'seki' ? 'gomoku-seki' : 'gomoku',
    seats,
    settings: {},
  };
  match.handle(create);
  match.handle({ v: 1, t: 'player.ready', matchId: 'g1', playerId: 'host' });
  match.handle({ v: 1, t: 'player.ready', matchId: 'g1', playerId: 'guest' });
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

test('free gomoku uses 11x11 and black moves first', () => {
  assert.equal(boardSize('free'), 11);
  assert.equal(initialBoard('free').length, 121);
  assert.equal(firstTurn('free'), 'black');
  const { sent } = createMatch('free');
  const host = lastView(sent, 'host');
  assert.equal(host.turn, 'black');
  assert.equal(host.you.color, 'black');
  assert.equal(actions(sent, 'host').filter((action) => action.type === 'place').length, 121);
});

test('seki gomoku uses 15x15, has the comet stones and white moves first', () => {
  assert.equal(boardSize('seki'), 15);
  const board = initialBoard('seki');
  assert.equal(board.length, 225);
  assert.equal(board[7 * 15 + 7], 'black');
  assert.equal(board[6 * 15 + 8], 'white');
  assert.equal(board[9 * 15 + 5], 'black');
  assert.equal(board.filter((cell) => cell === 'black').length, 2);
  assert.equal(board.filter((cell) => cell === 'white').length, 1);
  assert.equal(firstTurn('seki'), 'white');
  const { sent } = createMatch('seki');
  const host = lastView(sent, 'host');
  const guest = lastView(sent, 'guest');
  assert.equal(host.you.color, 'black');
  assert.equal(guest.you.color, 'white');
  assert.equal(host.turn, 'white');
  assert.equal(actions(sent, 'guest').filter((action) => action.type === 'place').length, 222);
  assert.equal(actions(sent, 'host').filter((action) => action.type === 'place').length, 0);
});

test('findWin detects horizontal, vertical, diagonal and overlines', () => {
  const size = 11;
  const board = Array(121).fill(null);
  for (let c = 0; c < 5; c += 1) board[c] = 'black';
  assert.equal(findWin(board, size, 'black', 4)?.length, 5);
  const vertical = Array(121).fill(null);
  for (let r = 0; r < 6; r += 1) vertical[r * size + 2] = 'white';
  assert.equal(findWin(vertical, size, 'white', 5 * size + 2)?.length, 6);
  const diagonal = Array(121).fill(null);
  for (let i = 0; i < 5; i += 1) diagonal[i * size + i] = 'black';
  assert.equal(findWin(diagonal, size, 'black', 4 * size + 4)?.length, 5);
  assert.equal(findWin(Array(121).fill(null), size, 'black', 0), null);
});

test('free gomoku awards a five-in-a-row win', () => {
  const { match, sent } = createMatch('free');
  for (let c = 0; c < 5; c += 1) {
    match.handle({
      v: 1,
      t: 'action',
      matchId: 'g1',
      playerId: 'host',
      seq: 1,
      actionId: `h-${c}`,
      action: { type: 'place', index: c },
    });
    if (c < 4) {
      match.handle({
        v: 1,
        t: 'action',
        matchId: 'g1',
        playerId: 'guest',
        seq: 1,
        actionId: `g-${c}`,
        action: { type: 'place', index: 110 + c },
      });
    }
  }
  const result = sent.findLast((message) => message.t === 'result');
  assert.ok(result && result.t === 'result');
  assert.deepEqual((result.result as { winners: string[] }).winners, ['host']);
  assert.equal((result.result as { reason: string }).reason, 'five');
  assert.equal((result.result as { winningLine: number[] }).winningLine.length, 5);
});

test('free draw is a white win, seki draw is a loss for both', () => {
  const colors = { black: 'host', white: 'guest' };
  assert.deepEqual(drawOutcome('free', colors), {
    winners: ['guest'],
    reason: 'draw_white_win',
    winnerColor: 'white',
  });
  assert.deepEqual(drawOutcome('seki', colors), {
    winners: [],
    reason: 'draw_both_lose',
    bothLose: true,
  });
});

test('either player can resign in gomoku', () => {
  const { match, sent } = createMatch('free');
  match.handle({
    v: 1,
    t: 'action',
    matchId: 'g1',
    playerId: 'guest',
    seq: 1,
    actionId: 'r1',
    action: { type: 'resign' },
  });
  const result = sent.findLast((message) => message.t === 'result');
  assert.ok(result && result.t === 'result');
  assert.deepEqual((result.result as { winners: string[] }).winners, ['host']);
});

test('all 26 specified openings can be applied and lead to white move 4', () => {
  assert.equal(OPENINGS.length, 26);
  assert.equal(new Set(OPENINGS.map((opening) => opening.name)).size, 26);
  for (const opening of OPENINGS) {
    const applied = applyOpening(Array(225).fill(null), 15, opening.name);
    assert.ok(applied, opening.name);
    assert.equal(applied!.board.filter((cell) => cell === 'black').length, 2, opening.name);
    assert.equal(applied!.board.filter((cell) => cell === 'white').length, 1, opening.name);
  }
  const { match, sent } = createMatch('forbidden');
  match.handle({ v: 1, t: 'action', matchId: 'g1', playerId: 'host', seq: 1, actionId: 'o1', action: { type: 'opening', name: '花月' } });
  const view = lastView(sent, 'host');
  assert.equal(view.phase, 'playing');
  assert.equal(view.turn, 'white');
  assert.equal(view.openingName, '花月');
});

test('only-forbidden mode plays white 4 normally and rejects black forbidden points', () => {
  const { match, sent } = createMatch('forbidden');
  match.handle({ v: 1, t: 'action', matchId: 'g1', playerId: 'host', seq: 1, actionId: 'o1', action: { type: 'opening', name: '花月' } });
  match.handle({ v: 1, t: 'action', matchId: 'g1', playerId: 'guest', seq: 2, actionId: 'w4', action: { type: 'place', index: 0 } });
  const after = lastView(sent, 'host');
  assert.equal(after.phase, 'playing');
  assert.equal(after.turn, 'black');
  const board = Array(225).fill(null);
  for (let c = 0; c < 5; c += 1) board[c] = 'black';
  assert.ok(forbiddenPoints(board, 15).includes(5));
  const blackView = lastView(sent, 'host');
  assert.equal(Array.isArray(blackView.forbidden), true);
});

test('RIF mode performs opening, three-move swap and five-move two choices', () => {
  const { match, sent } = createMatch('rif');
  match.handle({ v: 1, t: 'action', matchId: 'g1', playerId: 'host', seq: 1, actionId: 'o1', action: { type: 'opening', name: '花月' } });
  assert.equal(lastView(sent, 'host').phase, 'swap');
  // The guest is the tentative White and chooses to swap.
  match.handle({ v: 1, t: 'action', matchId: 'g1', playerId: 'guest', seq: 2, actionId: 'swap', action: { type: 'swap' } });
  const hostView = lastView(sent, 'host');
  const guestView = lastView(sent, 'guest');
  assert.equal(hostView.phase, 'playing');
  assert.equal(hostView.you.color, 'white');
  assert.equal(guestView.you.color, 'black');
  assert.equal(hostView.turn, 'white');
  // New White (host) plays white 4.
  match.handle({ v: 1, t: 'action', matchId: 'g1', playerId: 'host', seq: 3, actionId: 'w4', action: { type: 'place', index: 0 } });
  const offer = lastView(sent, 'guest');
  assert.equal(offer.phase, 'fifth-offer');
  assert.equal(offer.turn, 'black');
  // New Black (guest) offers two points.
  match.handle({ v: 1, t: 'action', matchId: 'g1', playerId: 'guest', seq: 4, actionId: 'f5', action: { type: 'fifth-propose', indices: [200, 201] } });
  const choose = lastView(sent, 'host');
  assert.equal(choose.phase, 'fifth-choose');
  assert.deepEqual(choose.fifthOptions, [200, 201]);
  // White chooses one; the other is not placed.
  match.handle({ v: 1, t: 'action', matchId: 'g1', playerId: 'host', seq: 5, actionId: 'f5c', action: { type: 'fifth-choose', index: 201 } });
  const finalView = lastView(sent, 'host');
  assert.equal(finalView.phase, 'playing');
  assert.equal(finalView.turn, 'white');
  assert.equal(finalView.board[201], 'black');
  assert.equal(finalView.board[200], null);
});
