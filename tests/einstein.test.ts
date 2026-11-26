import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EinsteinMatch,
  coordinate,
  initialBoard,
  initialPieces,
  legalTargets,
  requiredNumber,
} from '../src/games/einstein/game.js';
import type { GameToPlatform, PlatformToGame, Seat } from '../src/protocol/protocol.js';

const seats: Seat[] = [
  { userId: 'host', name: 'Host', seat: 0, ready: true },
  { userId: 'guest', name: 'Guest', seat: 1, ready: true },
];
const blackNumbers = { b1: 1, b2: 2, b3: 3, b4: 4, b5: 5, b6: 6 };
const whiteNumbers = { w1: 1, w2: 2, w3: 3, w4: 4, w5: 5, w6: 6 };

function createMatch(die = 4) {
  const sent: GameToPlatform[] = [];
  const match = new EinsteinMatch((message) => sent.push(message), () => die);
  const create: PlatformToGame = {
    v: 1,
    t: 'match.create',
    matchId: 'e1',
    gameId: 'einstein',
    seats,
    settings: {},
  };
  match.handle(create);
  match.handle({ v: 1, t: 'player.ready', matchId: 'e1', playerId: 'host' });
  match.handle({ v: 1, t: 'player.ready', matchId: 'e1', playerId: 'guest' });
  return { match, sent };
}

function lastView(sent: GameToPlatform[], playerId: string): any {
  for (let i = sent.length - 1; i >= 0; i -= 1) {
    const message = sent[i]!;
    if (message.t === 'view' && message.to === `player:${playerId}`) return message.view;
  }
  throw new Error('view not found');
}

test('einstein has the specified initial deployment', () => {
  const pieces = initialPieces();
  assert.equal(pieces.length, 12);
  assert.deepEqual(
    pieces.filter((piece) => piece.color === 'black').map((piece) => coordinate(piece.index)),
    ['A1', 'A2', 'A3', 'B1', 'B2', 'C1'],
  );
  assert.deepEqual(
    pieces.filter((piece) => piece.color === 'white').map((piece) => coordinate(piece.index)),
    ['C5', 'D4', 'D5', 'E3', 'E4', 'E5'],
  );
  assert.equal(initialBoard(pieces).filter((cell) => cell === 'black').length, 6);
  assert.equal(initialBoard(pieces).filter((cell) => cell === 'white').length, 6);
});

test('movement is one square in the allowed directions', () => {
  assert.deepEqual(legalTargets(0, 'black'), [1, 5, 6]);
  assert.deepEqual(legalTargets(24, 'white'), [23, 19, 18]);
  assert.deepEqual(legalTargets(4, 'black'), [9]);
  assert.deepEqual(legalTargets(20, 'white'), [15]);
});

test('closest number uses the lower number on a tie', () => {
  const pieces = initialPieces();
  pieces[0]!.number = 3;
  pieces[1]!.number = 5;
  pieces[2]!.number = 1;
  pieces[3]!.number = 2;
  pieces[4]!.number = 4;
  pieces[5]!.number = 6;
  assert.equal(requiredNumber(pieces, 'black', 4), 4);
  assert.equal(requiredNumber(pieces, 'black', 3), 3);
  // Remove 4 so roll 4 ties between 3 and 5; lower wins.
  pieces[4]!.number = null;
  assert.equal(requiredNumber(pieces, 'black', 4), 3);
});

test('both players number, then the die determines the required piece', () => {
  const { match, sent } = createMatch(4);
  assert.equal(lastView(sent, 'host').phase, 'numbering');
  assert.equal(lastView(sent, 'host').numberingSubmitted, false);
  match.handle({
    v: 1, t: 'action', matchId: 'e1', playerId: 'host', seq: 1, actionId: 'n1',
    action: { type: 'numbering', numbers: blackNumbers },
  });
  assert.equal(lastView(sent, 'host').numberingSubmitted, true);
  assert.equal(lastView(sent, 'host').phase, 'numbering');
  match.handle({
    v: 1, t: 'action', matchId: 'e1', playerId: 'guest', seq: 2, actionId: 'n2',
    action: { type: 'numbering', numbers: whiteNumbers },
  });
  const view = lastView(sent, 'host');
  assert.equal(view.phase, 'playing');
  assert.equal(view.roll, 4);
  assert.equal(view.requiredNumber, 4);
  assert.equal(view.requiredPiece, 1); // B1, black piece b4
  assert.equal(lastView(sent, 'guest').roll, 4);
});

test('select the die piece, move one square and switch to white', () => {
  const { match, sent } = createMatch(4);
  match.handle({ v: 1, t: 'action', matchId: 'e1', playerId: 'host', seq: 1, actionId: 'n1', action: { type: 'numbering', numbers: blackNumbers } });
  match.handle({ v: 1, t: 'action', matchId: 'e1', playerId: 'guest', seq: 2, actionId: 'n2', action: { type: 'numbering', numbers: whiteNumbers } });
  const before = lastView(sent, 'host');
  match.handle({ v: 1, t: 'action', matchId: 'e1', playerId: 'host', seq: 3, actionId: 's1', action: { type: 'select', index: before.requiredPiece } });
  const selected = lastView(sent, 'host');
  assert.equal(selected.selected, 1);
  assert.deepEqual(selected.moveTargets.sort((a: number, b: number) => a - b), [2, 6, 7]);
  match.handle({ v: 1, t: 'action', matchId: 'e1', playerId: 'host', seq: 4, actionId: 'm1', action: { type: 'move', to: 7 } });
  const after = lastView(sent, 'host');
  assert.equal(after.board[1], null);
  assert.equal(after.board[7], 'black');
  assert.equal(after.turn, 'white');
  assert.equal(after.phase, 'playing');
  assert.equal(after.roll, 4);
  assert.equal(after.requiredNumber, 4);
});

test('moving onto an own piece removes that piece and keeps the mover', () => {
  const { match, sent } = createMatch(4);
  match.handle({ v: 1, t: 'action', matchId: 'e1', playerId: 'host', seq: 1, actionId: 'n1', action: { type: 'numbering', numbers: blackNumbers } });
  match.handle({ v: 1, t: 'action', matchId: 'e1', playerId: 'guest', seq: 2, actionId: 'n2', action: { type: 'numbering', numbers: whiteNumbers } });
  const before = lastView(sent, 'host');
  match.handle({ v: 1, t: 'action', matchId: 'e1', playerId: 'host', seq: 3, actionId: 's1', action: { type: 'select', index: before.requiredPiece } });
  // B1 -> C1 captures own b6.
  match.handle({ v: 1, t: 'action', matchId: 'e1', playerId: 'host', seq: 4, actionId: 'm1', action: { type: 'move', to: 2 } });
  const after = lastView(sent, 'host');
  assert.equal(after.board[1], null);
  assert.equal(after.board[2], 'black');
  assert.equal(after.pieces.filter((piece: { color: string }) => piece.color === 'black').length, 5);
});

test('either player can resign', () => {
  const { match, sent } = createMatch();
  match.handle({ v: 1, t: 'action', matchId: 'e1', playerId: 'guest', seq: 1, actionId: 'r1', action: { type: 'resign' } });
  const result = sent.findLast((message) => message.t === 'result');
  assert.ok(result && result.t === 'result');
  assert.deepEqual((result.result as { winners: string[] }).winners, ['host']);
});
