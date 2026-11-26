import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AmazonsMatch,
  hasAnyLegalTurn,
  initialBoard,
  queenTargets,
} from '../src/games/amazons/game.js';
import type { GameToPlatform, PlatformToGame, Seat } from '../src/protocol/protocol.js';

const seats: Seat[] = [
  { userId: 'host', name: 'Host', seat: 0, ready: true },
  { userId: 'guest', name: 'Guest', seat: 1, ready: true },
];

function createMatch() {
  const sent: GameToPlatform[] = [];
  const match = new AmazonsMatch((message) => sent.push(message));
  const create: PlatformToGame = {
    v: 1,
    t: 'match.create',
    matchId: 'a1',
    gameId: 'amazons',
    seats,
    settings: {},
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

test('amazons has the specified initial pieces and coordinate layout', () => {
  const board = initialBoard();
  assert.equal(board.length, 100);
  assert.deepEqual(
    board.map((cell, index) => (cell ? [index, cell] : null)).filter(Boolean),
    [
      [3, 'black'],
      [6, 'black'],
      [30, 'black'],
      [39, 'black'],
      [60, 'white'],
      [69, 'white'],
      [93, 'white'],
      [96, 'white'],
    ],
  );
  assert.equal(hasAnyLegalTurn(board, 'black'), true);
  assert.equal(hasAnyLegalTurn(board, 'white'), true);
});

test('queen movement stops before arrows and pieces', () => {
  const board = Array(100).fill(null);
  board[35] = 'black';
  board[36] = 'arrow';
  const targets = queenTargets(board, 35);
  assert.equal(targets.includes(36), false);
  assert.equal(targets.includes(37), false);
  assert.equal(targets.includes(34), true);
  board[25] = 'white';
  assert.equal(queenTargets(board, 35).includes(25), false);
  assert.equal(queenTargets(board, 35).includes(15), false);
});

test('select, move and shoot completes one turn and switches to white', () => {
  const { match, sent } = createMatch();
  const initial = lastView(sent, 'host');
  assert.equal(initial.turn, 'black');
  assert.equal(initial.phase, 'move');
  const piece = initial.board.findIndex((cell: string | null) => cell === 'black');
  match.handle({
    v: 1, t: 'action', matchId: 'a1', playerId: 'host', seq: 1, actionId: 'select',
    action: { type: 'select', index: piece },
  });
  const selected = lastView(sent, 'host');
  assert.equal(selected.selected, piece);
  assert.ok(selected.moveTargets.length > 0);
  const to = selected.moveTargets.find((index: number) => {
    const board = [...selected.board];
    board[piece] = null;
    board[index] = 'black';
    return queenTargets(board, index).length > 0;
  });
  assert.ok(to !== undefined);
  match.handle({
    v: 1, t: 'action', matchId: 'a1', playerId: 'host', seq: 2, actionId: 'move',
    action: { type: 'move', to },
  });
  const arrowView = lastView(sent, 'host');
  assert.equal(arrowView.phase, 'arrow');
  assert.ok(arrowView.shotTargets.length > 0);
  const arrow = arrowView.shotTargets[0];
  match.handle({
    v: 1, t: 'action', matchId: 'a1', playerId: 'host', seq: 3, actionId: 'shoot',
    action: { type: 'shoot', index: arrow },
  });
  const after = lastView(sent, 'host');
  assert.equal(after.turn, 'white');
  assert.equal(after.phase, 'move');
  assert.equal(after.board[arrow], 'arrow');
  assert.equal(after.lastMove.arrow, arrow);
});

test('a side with no legal turn cannot move', () => {
  const board = Array(100).fill('arrow') as Array<'black' | 'white' | 'arrow' | null>;
  board[0] = 'black';
  board[99] = 'white';
  assert.equal(hasAnyLegalTurn(board, 'black'), false);
  assert.equal(hasAnyLegalTurn(board, 'white'), false);
});

test('either player can resign', () => {
  const { match, sent } = createMatch();
  match.handle({
    v: 1, t: 'action', matchId: 'a1', playerId: 'guest', seq: 1, actionId: 'r1',
    action: { type: 'resign' },
  });
  const result = sent.findLast((message) => message.t === 'result');
  assert.ok(result && result.t === 'result');
  assert.deepEqual((result.result as { winners: string[] }).winners, ['host']);
});
