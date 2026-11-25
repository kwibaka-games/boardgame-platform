import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { io, type Socket } from 'socket.io-client';
import { loadConfig, type Config } from '../src/platform/config.js';
import { createPlatform, type Platform } from '../src/platform/server.js';
import { openDb } from '../src/platform/db.js';
import { createUser } from '../src/platform/auth.js';

const SECRET = 'test-game-secret';

function testConfig(): Config {
  return {
    ...loadConfig(),
    port: 0,
    host: '127.0.0.1',
    dbPath: ':memory:',
    webDir: new URL('../web', import.meta.url).pathname,
    publicOrigin: null,
    cookieSecure: false,
    sessionTtlMs: 60 * 60 * 1000,
    gameSecret: SECRET,
    loginRateLimit: 100,
  };
}

async function login(base: string, name: string, code: string): Promise<string> {
  const email = `${name.toLowerCase()}@test.local`;
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: code }),
  });
  assert.equal(response.status, 200, await response.text());
  const cookie = response.headers.getSetCookie()[0];
  assert.ok(cookie);
  return cookie.split(';')[0]!;
}

async function readyAll(base: string, roomId: string, cookies: string[]) {
  for (const cookie of cookies) {
    await api(base, `/api/rooms/${roomId}/ready`, cookie, {
      method: 'POST',
      body: JSON.stringify({ ready: true }),
    });
  }
}

async function api(base: string, path: string, cookie: string, init: RequestInit = {}) {
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
}

function connect(base: string, cookie: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(base, {
      transports: ['websocket'],
      extraHeaders: { Cookie: cookie },
      reconnection: false,
      timeout: 3000,
    });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function emitAck<T>(socket: Socket, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} ack timeout`)), 3000);
    socket.emit(event, payload, (result: T) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('waitFor timeout');
}

function waitEvent<T>(
  socket: Socket,
  event: string,
  predicate: (value: T) => boolean = () => true,
  timeoutMs = 5000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`${event} timeout`));
    }, timeoutMs);
    const handler = (value: T) => {
      if (!predicate(value)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(value);
    };
    socket.on(event, handler);
  });
}

async function startTestPlatform(users: [string, string][]) {
  const config = testConfig();
  const db = openDb(':memory:');
  for (const [name, code] of users) createUser(db, name, code);
  const platform = createPlatform(config, db);
  const port = await platform.listen(0, '127.0.0.1');
  return { platform, base: `http://127.0.0.1:${port}` };
}

test('two players can complete a mock game with per-player views and chat', async () => {
  const config = testConfig();
  const db = openDb(':memory:');
  createUser(db, 'Alice', 'alicecode');
  createUser(db, 'Bob', 'bobcode');

  const platform: Platform = createPlatform(config, db);
  const port = await platform.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  let aliceSocket: Socket | null = null;
  let bobSocket: Socket | null = null;

  try {
    const aliceCookie = await login(base, 'Alice', 'alicecode');
    const bobCookie = await login(base, 'Bob', 'bobcode');
    const meA = await api(base, '/api/me', aliceCookie);
    const meB = await api(base, '/api/me', bobCookie);

    const games = await api(base, '/api/games', aliceCookie);
    assert.equal(games.games[0].id, 'mock-ttt');

    const created = await api(base, '/api/rooms', aliceCookie, {
      method: 'POST',
      body: JSON.stringify({ gameId: 'mock-ttt', name: 'test room' }),
    });
    const roomId = created.room.id as string;
    await api(base, `/api/rooms/${roomId}/join`, bobCookie, { method: 'POST', body: '{}' });
    await readyAll(base, roomId, [aliceCookie, bobCookie]);

    aliceSocket = await connect(base, aliceCookie);
    bobSocket = await connect(base, bobCookie);
    assert.deepEqual(await emitAck(aliceSocket, 'room.subscribe', { roomId }), { ok: true });
    assert.deepEqual(await emitAck(bobSocket, 'room.subscribe', { roomId }), { ok: true });

    const aliceView = waitEvent<{ matchId: string; seq: number; view: { you: string } }>(
      aliceSocket,
      'game.view',
    );
    const bobView = waitEvent<{ matchId: string; seq: number; view: { you: string } }>(
      bobSocket,
      'game.view',
    );

    await api(base, `/api/rooms/${roomId}/start`, aliceCookie, { method: 'POST', body: '{}' });
    const firstA = await aliceView;
    const firstB = await bobView;
    assert.equal(firstA.view.you, meA.user.id);
    assert.equal(firstB.view.you, meB.user.id);
    assert.equal(firstA.matchId, firstB.matchId);

    const startedA = waitEvent(aliceSocket, 'game.started');
    const startedB = waitEvent(bobSocket, 'game.started');
    aliceSocket.emit('game.ready', { matchId: firstA.matchId });
    bobSocket.emit('game.ready', { matchId: firstA.matchId });
    await Promise.all([startedA, startedB]);

    const chatOnBob = waitEvent<{ text: string; userId: string }>(bobSocket, 'chat.message');
    assert.deepEqual(await emitAck(aliceSocket, 'chat.send', { text: 'hello' }), { ok: true });
    const chat = await chatOnBob;
    assert.equal(chat.text, 'hello');
    assert.equal(chat.userId, meA.user.id);

    const action = (socket: Socket, seq: number, cell: number) =>
      emitAck<{ ok: boolean; error?: string }>(socket, 'game.action', {
        matchId: firstA.matchId,
        seq,
        actionId: `test-${cell}-${Date.now()}`,
        action: { type: 'move', cell },
      });

    let aliceSeq = firstA.seq;
    let bobSeq = firstB.seq;
    const nextA = (cell: number) =>
      waitEvent<{ seq: number; view: { board: string[] } }>(
        aliceSocket!,
        'game.view',
        (value) => value.view.board[cell] === 'O' && value.seq > aliceSeq,
      );
    const nextB = (cell: number) =>
      waitEvent<{ seq: number; view: { board: string[] } }>(
        bobSocket!,
        'game.view',
        (value) => value.view.board[cell] === 'X' && value.seq > bobSeq,
      );

    // Alice 0, Bob 3, Alice 1, Bob 4, Alice 2 -> Alice wins.
    let bobUpdate = nextB(0);
    assert.equal((await action(aliceSocket, aliceSeq, 0)).ok, true);
    const afterA1 = await bobUpdate;
    bobSeq = afterA1.seq;

    // A stale action is rejected by the platform and must not reach the game.
    const stale = await action(bobSocket, firstB.seq, 8);
    assert.equal(stale.ok, false);

    let aliceUpdate = nextA(3);
    assert.equal((await action(bobSocket, bobSeq, 3)).ok, true);
    const afterB1 = await aliceUpdate;
    aliceSeq = afterB1.seq;

    bobUpdate = nextB(1);
    assert.equal((await action(aliceSocket, aliceSeq, 1)).ok, true);
    const afterA2 = await bobUpdate;
    bobSeq = afterA2.seq;

    aliceUpdate = nextA(4);
    assert.equal((await action(bobSocket, bobSeq, 4)).ok, true);
    const afterB2 = await aliceUpdate;
    aliceSeq = afterB2.seq;

    const resultEvent = waitEvent<{ result: { winners: string[] } }>(aliceSocket, 'game.result');
    assert.equal((await action(aliceSocket, aliceSeq, 2)).ok, true);
    const result = await resultEvent;
    assert.deepEqual(result.result.winners, [meA.user.id]);

    const restarted = await api(base, `/api/rooms/${roomId}/restart`, aliceCookie, {
      method: 'POST',
      body: '{}',
    });
    assert.equal(restarted.room.status, 'waiting');
    assert.equal(restarted.room.allReady, false);
    assert.equal(restarted.room.players.every((player: { ready: boolean }) => !player.ready), true);
  } finally {
    aliceSocket?.close();
    bobSocket?.close();
    await platform.close();
  }
});

test('spectators see the full view and can chat in a perfect-information game', async () => {
  const { platform, base } = await startTestPlatform([
    ['Alice', 'alicecode'],
    ['Bob', 'bobcode'],
    ['Carol', 'carolcode'],
  ]);
  let aliceSocket: Socket | null = null;
  let bobSocket: Socket | null = null;
  let carolSocket: Socket | null = null;

  try {
    const aliceCookie = await login(base, 'Alice', 'alicecode');
    const bobCookie = await login(base, 'Bob', 'bobcode');
    const carolCookie = await login(base, 'Carol', 'carolcode');
    const alice = await api(base, '/api/me', aliceCookie);
    const bob = await api(base, '/api/me', bobCookie);

    const created = await api(base, '/api/rooms', aliceCookie, {
      method: 'POST',
      body: JSON.stringify({ gameId: 'mock-ttt', name: 'spectator room' }),
    });
    const roomId = created.room.id as string;
    await api(base, `/api/rooms/${roomId}/join`, bobCookie, { method: 'POST', body: '{}' });
    await readyAll(base, roomId, [aliceCookie, bobCookie]);

    aliceSocket = await connect(base, aliceCookie);
    bobSocket = await connect(base, bobCookie);
    assert.deepEqual(await emitAck(aliceSocket, 'room.subscribe', { roomId }), { ok: true });
    assert.deepEqual(await emitAck(bobSocket, 'room.subscribe', { roomId }), { ok: true });

    const aliceView = waitEvent<{ matchId: string; seq: number; view: { you: string } }>(
      aliceSocket,
      'game.view',
    );
    const bobView = waitEvent<{ matchId: string; seq: number; view: { you: string } }>(
      bobSocket,
      'game.view',
    );
    await api(base, `/api/rooms/${roomId}/start`, aliceCookie, { method: 'POST', body: '{}' });
    const firstA = await aliceView;
    const firstB = await bobView;

    const startedA = waitEvent(aliceSocket, 'game.started');
    const startedB = waitEvent(bobSocket, 'game.started');
    aliceSocket.emit('game.ready', { matchId: firstA.matchId });
    bobSocket.emit('game.ready', { matchId: firstA.matchId });
    await Promise.all([startedA, startedB]);

    carolSocket = await connect(base, carolCookie);
    const spectatorState = waitEvent<{ spectatorChat: boolean; you: { spectator: boolean } }>(
      carolSocket,
      'room.state',
      (state) => state.you?.spectator === true,
    );
    const spectatorView = waitEvent<{
      view: { you: null; board: string[] };
    }>(carolSocket, 'game.view');
    assert.deepEqual(
      await emitAck(carolSocket, 'room.subscribe', { roomId, spectate: true }),
      { ok: true },
    );
    const state = await spectatorState;
    const view = await spectatorView;
    assert.equal(state.spectatorChat, true);
    assert.equal(view.view.you, null);
    assert.equal(view.view.board.length, 9);

    const bobChat = waitEvent<{ role: string; text: string }>(bobSocket, 'chat.message');
    assert.deepEqual(
      await emitAck(carolSocket, 'chat.send', { text: 'hello from the gallery' }),
      { ok: true },
    );
    const chat = await bobChat;
    assert.equal(chat.role, 'spectator');
    assert.equal(chat.text, 'hello from the gallery');

    const spectatorUpdate = waitEvent<{ view: { board: string[] } }>(
      carolSocket,
      'game.view',
      (payload) => payload.view.board[0] === 'X',
    );
    assert.equal(
      (
        await emitAck<{ ok: boolean }>(aliceSocket, 'game.action', {
          matchId: firstA.matchId,
          seq: firstA.seq,
          actionId: `spectator-move-${Date.now()}`,
          action: { type: 'move', cell: 0 },
        })
      ).ok,
      true,
    );
    const updated = await spectatorUpdate;
    assert.equal(updated.view.board[0], 'X');
  } finally {
    aliceSocket?.close();
    bobSocket?.close();
    carolSocket?.close();
    await platform.close();
  }
});

test('hidden-information games can disable spectator chat without hiding the view', async () => {
  const { platform, base } = await startTestPlatform([
    ['Alice', 'alicecode'],
    ['Bob', 'bobcode'],
    ['Carol', 'carolcode'],
  ]);
  const originalGet = platform.catalog.get.bind(platform.catalog);
  let carolSocket: Socket | null = null;

  try {
    // Simulate a game whose metadata says spectators may watch but not chat.
    (platform.catalog as unknown as { get: typeof originalGet }).get = (gameId: string) => {
      const metadata = originalGet(gameId);
      return metadata ? { ...metadata, spectatorChat: false } : null;
    };

    const aliceCookie = await login(base, 'Alice', 'alicecode');
    const bobCookie = await login(base, 'Bob', 'bobcode');
    const carolCookie = await login(base, 'Carol', 'carolcode');
    const created = await api(base, '/api/rooms', aliceCookie, {
      method: 'POST',
      body: JSON.stringify({ gameId: 'mock-ttt', name: 'hidden room' }),
    });
    const roomId = created.room.id as string;
    await api(base, `/api/rooms/${roomId}/join`, bobCookie, { method: 'POST', body: '{}' });
    await readyAll(base, roomId, [aliceCookie, bobCookie]);
    await api(base, `/api/rooms/${roomId}/start`, aliceCookie, { method: 'POST', body: '{}' });

    carolSocket = await connect(base, carolCookie);
    const statePromise = waitEvent<{ spectatorChat: boolean; you: { spectator: boolean } }>(
      carolSocket,
      'room.state',
      (state) => state.you?.spectator === true,
    );
    assert.deepEqual(
      await emitAck(carolSocket, 'room.subscribe', { roomId, spectate: true }),
      { ok: true },
    );
    const state = await statePromise;
    assert.equal(state.spectatorChat, false);
    assert.equal(
      (await emitAck<{ ok: boolean; error?: string }>(carolSocket, 'chat.send', { text: 'nope' })).ok,
      false,
    );
  } finally {
    carolSocket?.close();
    (platform.catalog as unknown as { get: typeof originalGet }).get = originalGet;
    await platform.close();
  }
});

test('a crashed room worker is logged, aborted, excluded from stats, and isolated', async () => {
  const { platform, base } = await startTestPlatform([
    ['Alice', 'alicecode'],
    ['Bob', 'bobcode'],
    ['Carol', 'carolcode'],
    ['Dave', 'davecode'],
  ]);

  try {
    const aliceCookie = await login(base, 'Alice', 'alicecode');
    const bobCookie = await login(base, 'Bob', 'bobcode');
    const carolCookie = await login(base, 'Carol', 'carolcode');
    const daveCookie = await login(base, 'Dave', 'davecode');

    const createdA = await api(base, '/api/rooms', aliceCookie, {
      method: 'POST',
      body: JSON.stringify({ gameId: 'mock-ttt', name: 'crash room A' }),
    });
    const roomA = createdA.room.id as string;
    await api(base, `/api/rooms/${roomA}/join`, bobCookie, { method: 'POST', body: '{}' });
    await readyAll(base, roomA, [aliceCookie, bobCookie]);
    await api(base, `/api/rooms/${roomA}/start`, aliceCookie, { method: 'POST', body: '{}' });

    const createdB = await api(base, '/api/rooms', carolCookie, {
      method: 'POST',
      body: JSON.stringify({ gameId: 'mock-ttt', name: 'crash room B' }),
    });
    const roomB = createdB.room.id as string;
    await api(base, `/api/rooms/${roomB}/join`, daveCookie, { method: 'POST', body: '{}' });
    await readyAll(base, roomB, [carolCookie, daveCookie]);
    await api(base, `/api/rooms/${roomB}/start`, carolCookie, { method: 'POST', body: '{}' });

    const roomAAfterStart = await api(base, `/api/rooms/${roomA}`, aliceCookie);
    const roomBAfterStart = await api(base, `/api/rooms/${roomB}`, carolCookie);
    const matchA = roomAAfterStart.room.matchId as string;
    const matchB = roomBAfterStart.room.matchId as string;
    assert.notEqual(matchA, matchB);

    await waitFor(async () => {
      const current = await api(base, `/api/rooms/${roomA}`, aliceCookie);
      return (
        ['starting', 'playing'].includes(current.room.status) &&
        !!platform.workers.getPid(matchA)
      );
    });
    await waitFor(async () => {
      const current = await api(base, `/api/rooms/${roomB}`, carolCookie);
      return (
        ['starting', 'playing'].includes(current.room.status) &&
        !!platform.workers.getPid(matchB)
      );
    });

    const pidA = platform.workers.getPid(matchA);
    const pidB = platform.workers.getPid(matchB);
    assert.ok(pidA);
    assert.ok(pidB);
    assert.notEqual(pidA, pidB);
    process.kill(pidA, 'SIGKILL');

    await waitFor(async () => {
      const current = await api(base, `/api/rooms/${roomA}`, aliceCookie);
      return current.room.status === 'waiting';
    });
    const isolated = await api(base, `/api/rooms/${roomB}`, carolCookie);
    assert.ok(['starting', 'playing'].includes(isolated.room.status));

    const crashed = platform.db
      .prepare('SELECT status, error FROM matches WHERE id = ?')
      .get(matchA) as { status: string; error: string } | undefined;
    assert.equal(crashed?.status, 'crashed');
    assert.match(crashed?.error ?? '', /worker|exit|closed|crash/i);

    assert.ok(existsSync('data/logs/crashes.log'));
    assert.match(readFileSync('data/logs/crashes.log', 'utf8'), new RegExp(matchA));

    const stats = await api(base, '/api/stats/me', aliceCookie);
    assert.equal(stats.total, 0);
  } finally {
    await platform.close();
  }
});
