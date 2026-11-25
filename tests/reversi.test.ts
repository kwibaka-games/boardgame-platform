import assert from 'node:assert/strict';
import test from 'node:test';
import { ReversiMatch, countDiscs, flipsFor, initialBoard, legalMoves } from '../src/games/reversi/game.js';
import type { GameToPlatform, PlatformToGame, Seat } from '../src/protocol/protocol.js';

const seats: Seat[] = [
  { userId: 'host', name: 'Host', seat: 0, ready: true },
  { userId: 'guest', name: 'Guest', seat: 1, ready: true },
];

function createMatch(settings: Record<string, unknown> = { hostUserId: 'host', hostColor: 'black' }) {
  const sent: GameToPlatform[] = [];
  const match = new ReversiMatch((message) => sent.push(message));
  const create: PlatformToGame = {
    v: 1,
    t: 'match.create',
    matchId: 'r1',
    gameId: 'reversi',
    seats,
    settings,
  };
  match.handle(create);
  match.handle({ v: 1, t: 'player.ready', matchId: 'r1', playerId: 'host' });
  match.handle({ v: 1, t: 'player.ready', matchId: 'r1', playerId: 'guest' });
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

test('reversi starts with the standard four discs and four black moves', () => {
  const board = initialBoard();
  assert.deepEqual(countDiscs(board), { black: 2, white: 2 });
  assert.deepEqual(legalMoves(board, 'black').sort((a, b) => a - b), [19, 26, 37, 44]);
  assert.equal(flipsFor(board, 19, 'black').length, 1);
});

test('host color setting assigns the guest the opposite color', () => {
  const { sent } = createMatch({ hostUserId: 'host', hostColor: 'white' });
  const host = lastView(sent, 'host');
  const guest = lastView(sent, 'guest');
  assert.equal(host.you.color, 'white');
  assert.equal(guest.you.color, 'black');
  assert.equal(host.turn, 'black');
  assert.equal(actions(sent, 'guest').filter((action) => action.type === 'place').length, 4);
  assert.equal(actions(sent, 'host').filter((action) => action.type === 'place').length, 0);
});

test('a legal move flips discs and switches turns', () => {
  const { match, sent } = createMatch();
  const view = lastView(sent, 'host');
  const move = legalMoves(view.board, 'black')[0]!;
  match.handle({ v: 1, t: 'action', matchId: 'r1', playerId: 'host', seq: 1, actionId: 'a1', action: { type: 'place', index: move } });
  const after = lastView(sent, 'host');
  assert.equal(after.turn, 'white');
  assert.equal(after.counts.black, 4);
  assert.equal(after.counts.white, 1);
});

test('either player can resign and the opponent wins', () => {
  const { match, sent } = createMatch();
  match.handle({ v: 1, t: 'action', matchId: 'r1', playerId: 'guest', seq: 1, actionId: 'r1', action: { type: 'resign' } });
  const final = sent.find((message) => message.t === 'result');
  assert.ok(final && final.t === 'result');
  assert.deepEqual((final.result as { winners: string[] }).winners, ['host']);
  assert.equal(lastView(sent, 'host').status, 'finished');
  assert.equal(lastView(sent, 'guest').result.reason, 'resign');
});

test('reversi platform integration passes host color and starts a real worker', async () => {
  const { createPlatform } = await import('../src/platform/server.js');
  const { openDb } = await import('../src/platform/db.js');
  const { createUser } = await import('../src/platform/auth.js');
  const { loadConfig } = await import('../src/platform/config.js');
  const { io: connectIo } = await import('socket.io-client');

  const db = openDb(':memory:');
  createUser(db, 'RevHost', 'revhost1');
  createUser(db, 'RevGuest', 'revguest1');
  const config = {
    ...loadConfig(),
    port: 0,
    host: '127.0.0.1',
    dbPath: ':memory:',
    webDir: new URL('../web', import.meta.url).pathname,
    publicOrigin: null,
    publicOrigins: [],
    cookieSecure: false,
    sessionTtlMs: 60_000,
    gameSecret: 'reversi-test-secret',
    loginRateLimit: 100,
    emailDebug: true,
    smtpHost: null,
    adminEmail: null,
    roomWaitTimeoutMs: 60_000,
  };
  const platform = createPlatform(config, db);
  const base = `http://127.0.0.1:${await platform.listen(0, '127.0.0.1')}`;
  const sockets: any[] = [];
  try {
    const login = async (email: string, password: string) => {
      const response = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      assert.equal(response.status, 200);
      return response.headers.getSetCookie()[0]!.split(';')[0]!;
    };
    const api = async (path: string, cookie: string, init: RequestInit = {}) => {
      const response = await fetch(`${base}${path}`, {
        ...init,
        headers: {
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          Cookie: cookie,
          ...(init.headers ?? {}),
        },
      });
      const body = await response.json().catch(() => ({}));
      assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(body)}`);
      return body;
    };
    const hostCookie = await login('revhost@test.local', 'revhost1');
    const guestCookie = await login('revguest@test.local', 'revguest1');
    const created = await api('/api/rooms', hostCookie, {
      method: 'POST',
      body: JSON.stringify({ gameId: 'reversi' }),
    });
    const roomId = created.room.id as string;
    await api(`/api/rooms/${roomId}/join`, guestCookie, { method: 'POST', body: '{}' });
    await api(`/api/rooms/${roomId}/settings`, hostCookie, {
      method: 'POST',
      body: JSON.stringify({ settings: { hostColor: 'white' } }),
    });
    await api(`/api/rooms/${roomId}/ready`, hostCookie, { method: 'POST', body: JSON.stringify({ ready: true }) });
    await api(`/api/rooms/${roomId}/ready`, guestCookie, { method: 'POST', body: JSON.stringify({ ready: true }) });

    const connect = (cookie: string) =>
      new Promise<any>((resolve, reject) => {
        const socket = connectIo(base, {
          transports: ['websocket'],
          extraHeaders: { Cookie: cookie },
          reconnection: false,
          timeout: 3000,
        });
        socket.once('connect', () => resolve(socket));
        socket.once('connect_error', reject);
      });
    const hostSocket = await connect(hostCookie);
    const guestSocket = await connect(guestCookie);
    sockets.push(hostSocket, guestSocket);
    const hostView = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('host view timeout')), 5000);
      hostSocket.on('game.view', (payload: any) => {
        if (payload.view?.schema === 'reversi-v1') {
          clearTimeout(timer);
          resolve(payload.view);
        }
      });
    });
    const guestView = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('guest view timeout')), 5000);
      guestSocket.on('game.view', (payload: any) => {
        if (payload.view?.schema === 'reversi-v1') {
          clearTimeout(timer);
          resolve(payload.view);
        }
      });
    });
    await hostSocket.emit('room.subscribe', { roomId });
    await guestSocket.emit('room.subscribe', { roomId });
    await api(`/api/rooms/${roomId}/start`, hostCookie, { method: 'POST', body: '{}' });
    const firstHost = await hostView;
    const firstGuest = await guestView;
    assert.equal(firstHost.you.color, 'white');
    assert.equal(firstGuest.you.color, 'black');
  } finally {
    for (const socket of sockets) socket.close();
    await platform.close();
  }
});

test('random full games always terminate with a consistent result', () => {
  for (let game = 0; game < 40; game += 1) {
    const { match, sent } = createMatch({ hostUserId: 'host', hostColor: game % 2 ? 'white' : 'black' });
    let finished = false;
    for (let step = 0; step < 100; step += 1) {
      const current = sent.findLast((message) => message.t === 'result');
      if (current) {
        finished = true;
        break;
      }
      const hostActions = actions(sent, 'host');
      const guestActions = actions(sent, 'guest');
      const playerId = hostActions.some((action) => action.type === 'place') ? 'host' : 'guest';
      const legal = (playerId === 'host' ? hostActions : guestActions).filter(
        (action) => action.type === 'place',
      );
      if (legal.length === 0) {
        assert.fail(`game ${game} stuck without a result after ${step} moves`);
      }
      const action = legal[game % legal.length];
      match.handle({
        v: 1,
        t: 'action',
        matchId: 'r1',
        playerId,
        seq: 1,
        actionId: `a-${game}-${step}`,
        action,
      });
    }
    if (!finished) {
      const result = sent.findLast((message) => message.t === 'result');
      assert.ok(result, `game ${game} did not produce a result`);
    }
    const result = sent.findLast((message) => message.t === 'result');
    assert.ok(result && result.t === 'result');
    const board = (result.result as { board: (string | null)[] }).board;
    assert.equal(board.length, 64);
    assert.ok(board.every((cell) => cell === null || cell === 'black' || cell === 'white'));
  }
});
