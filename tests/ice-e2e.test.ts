import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { io, type Socket } from 'socket.io-client';
import { loadConfig, type Config } from '../src/platform/config.js';
import { createPlatform, type Platform } from '../src/platform/server.js';
import { openDb } from '../src/platform/db.js';
import { createUser } from '../src/platform/auth.js';

const SECRET = 'ice-e2e-secret';

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
  timeoutMs = 8000,
  intervalMs = 30,
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
  timeoutMs = 8000,
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

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface CapturedView {
  matchId: string;
  seq: number;
  view: {
    schema: string;
    phase: string;
    status: string;
    config: { mode: string; decisionTimeoutMs: number; playerCount: number };
    you: null | { userId: string; hand: { id: string; key: string }[]; pending?: { kind: string } };
    players: {
      userId: string;
      handCount: number;
      identity?: { id: string } | null;
      hand?: { id: string; key: string }[];
    }[];
    piles: {
      preservation: { count: number; cards?: { id: string }[] };
      accusations: { playerId: string; count: number; cards?: { id: string }[] }[];
      discard: { count: number; cards: { id: string }[] };
    };
    turn: null | { playerId: string; index: number };
    pending: null | { kind: string; blocking?: boolean };
    result?: {
      winners: { userId: string; reason: string }[];
      success: boolean;
      reason: string;
      reveal: { hands: { userId: string; cards: { id: string }[] }[] };
    };
  };
  actions: { type: string; cardId?: string; targetPlayerId?: string }[];
}

interface ResultPayload {
  matchId: string;
  result: {
    winners: string[];
    status: string;
    success: boolean;
    reason: string;
    category: string;
  };
}

test('ice: platform integration with private views, spectator reveal, full game, reconnect and stats', async () => {
  const config = testConfig();
  const db = openDb(':memory:');
  const users: [string, string][] = [
    ['Alice', 'alicecode'],
    ['Bob', 'bobcode'],
    ['Carol', 'carolcode'],
    ['Dave', 'davecode'],
  ];
  for (const [name, code] of users) createUser(db, name, code);
  const platform: Platform = createPlatform(config, db);
  const port = await platform.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;

  const sockets = new Map<string, Socket>();
  const latest = new Map<string, CapturedView>();
  const cookies = new Map<string, string>();
  const userIds = new Map<string, string>();
  let resultPayload: ResultPayload | null = null;
  let bobReconnected = false;

  const attach = (userId: string, socket: Socket) => {
    socket.on('game.view', (payload: CapturedView) => {
      latest.set(userId, payload);
    });
    socket.on('game.result', (payload: ResultPayload) => {
      resultPayload = payload;
    });
  };

  try {
    const aliceCookie = await login(base, 'Alice', 'alicecode');
    const bobCookie = await login(base, 'Bob', 'bobcode');
    const carolCookie = await login(base, 'Carol', 'carolcode');
    const daveCookie = await login(base, 'Dave', 'davecode');
    cookies.set('Alice', aliceCookie);
    cookies.set('Bob', bobCookie);
    cookies.set('Carol', carolCookie);
    cookies.set('Dave', daveCookie);

    const aliceMe = await api(base, '/api/me', aliceCookie);
    const bobMe = await api(base, '/api/me', bobCookie);
    const carolMe = await api(base, '/api/me', carolCookie);
    const daveMe = await api(base, '/api/me', daveCookie);
    userIds.set('Alice', aliceMe.user.id);
    userIds.set('Bob', bobMe.user.id);
    userIds.set('Carol', carolMe.user.id);
    userIds.set('Dave', daveMe.user.id);

    const games = await api(base, '/api/games', aliceCookie);
    const ice = games.games.find((game: { id: string }) => game.id === 'ice');
    assert.ok(ice, 'ice should be registered');
    assert.match(ice.name, /冰冷的她醒来之前/);
    assert.equal(ice.minPlayers, 3);
    assert.equal(ice.maxPlayers, 6);
    assert.equal(ice.spectatorChat, false);
    const iceChaos = games.games.find((game: { id: string }) => game.id === 'ice-chaos');
    assert.ok(iceChaos, 'ice-chaos should be registered');
    assert.match(iceChaos.name, /混沌/);
    assert.equal(iceChaos.spectatorChat, false);

    const created = await api(base, '/api/rooms', aliceCookie, {
      method: 'POST',
      body: JSON.stringify({ gameId: 'ice', name: 'ice e2e' }),
    });
    const roomId = created.room.id as string;
    await api(base, `/api/rooms/${roomId}/join`, bobCookie, { method: 'POST', body: '{}' });
    await api(base, `/api/rooms/${roomId}/join`, carolCookie, { method: 'POST', body: '{}' });
    await readyAll(base, roomId, [aliceCookie, bobCookie, carolCookie]);

    const daveSpectatorRoom = await api(base, `/api/rooms/${roomId}?spectate=1`, daveCookie);
    assert.equal(daveSpectatorRoom.room.spectatorChat, false);

    for (const [name, cookie] of [
      ['Alice', aliceCookie],
      ['Bob', bobCookie],
      ['Carol', carolCookie],
      ['Dave', daveCookie],
    ] as const) {
      const socket = await connect(base, cookie);
      sockets.set(name, socket);
      attach(userIds.get(name)!, socket);
    }

    for (const name of ['Alice', 'Bob', 'Carol'] as const) {
      assert.deepEqual(
        await emitAck(sockets.get(name)!, 'room.subscribe', { roomId }),
        { ok: true },
      );
    }
    assert.deepEqual(
      await emitAck(sockets.get('Dave')!, 'room.subscribe', { roomId, spectate: true }),
      { ok: true },
    );

    await api(base, `/api/rooms/${roomId}/start`, aliceCookie, { method: 'POST', body: '{}' });

    const playerIds = ['Alice', 'Bob', 'Carol'].map((name) => userIds.get(name)!);
    const daveId = userIds.get('Dave')!;

    await waitFor(
      () =>
        playerIds.every((id) => latest.has(id)) &&
        latest.has(daveId),
      12_000,
    );

    // Initial per-player views are private; the spectator view is complete.
    for (const name of ['Alice', 'Bob', 'Carol'] as const) {
      const captured = latest.get(userIds.get(name)!)!;
      assert.equal(captured.view.schema, 'ice-v1');
      assert.equal(captured.view.you?.hand.length, 6);
      assert.equal(captured.view.piles.preservation.cards, undefined);
      assert.equal(captured.view.piles.accusations.every((pile) => pile.cards === undefined), true);
    }
    const spectator = latest.get(daveId)!;
    assert.equal(spectator.view.you, null);
    assert.equal(spectator.view.players.every((player) => player.hand?.length === 6), true);
    assert.ok(Array.isArray(spectator.view.piles.preservation.cards));
    assert.equal(spectator.view.piles.accusations.every((pile) => Array.isArray(pile.cards)), true);

    // No player's view contains another player's hand card ids.
    for (const name of ['Alice', 'Bob', 'Carol'] as const) {
      const captured = latest.get(userIds.get(name)!)!;
      const ownId = userIds.get(name)!;
      const serialized = JSON.stringify(captured.view);
      for (const player of spectator.view.players) {
        if (player.userId === ownId) continue;
        for (const card of player.hand ?? []) {
          assert.equal(serialized.includes(card.id), false, `leaked ${card.id} to ${name}`);
        }
      }
    }

    // Spectators cannot chat in a hidden-information game.
    const spectatorChat = await emitAck<{ ok: boolean; error?: string }>(
      sockets.get('Dave')!,
      'chat.send',
      { text: 'hello from the gallery' },
    );
    assert.equal(spectatorChat.ok, false);

    // First view arrives before game.ready; now ready everyone.
    const started = waitEvent(sockets.get('Alice')!, 'game.started');
    for (const name of ['Alice', 'Bob', 'Carol'] as const) {
      sockets.get(name)!.emit('game.ready', { matchId: latest.get(userIds.get(name)!)!.matchId });
    }
    await started;

    await waitFor(
      () =>
        playerIds.some((id) => {
          const captured = latest.get(id);
          return (
            captured?.view.phase === 'playing' &&
            captured.view.turn?.playerId === id &&
            captured.actions.length > 0
          );
        }),
      12_000,
    );

    const current = () =>
      playerIds
        .map((id) => ({ id, captured: latest.get(id)! }))
        .find(
          (entry) =>
            entry.captured?.view.phase === 'playing' &&
            entry.captured.view.turn?.playerId === entry.id &&
            entry.captured.actions.length > 0,
        ) ?? null;

    const firstActor = current();
    assert.ok(firstActor);
    const firstSeq = firstActor.captured.seq;

    // Stale seq is rejected by the platform and does not reach the worker.
    const stale = await emitAck<{ ok: boolean; error?: string }>(
      sockets.get(
        ['Alice', 'Bob', 'Carol'].find((name) => userIds.get(name) !== firstActor.id)!,
      )!,
      'game.action',
      {
        matchId: firstActor.captured.matchId,
        seq: firstSeq - 1,
        actionId: randomUUID(),
        action: { type: 'preserve', cardId: 'anything' },
      },
    );
    assert.equal(stale.ok, false);
    assert.match(stale.error ?? '', /stale/i);

    // A legal-looking action from the wrong player is routed and rejected by
    // the worker with a targeted error event.
    const otherName = ['Alice', 'Bob', 'Carol'].find(
      (name) => userIds.get(name) !== firstActor.id,
    )!;
    const otherView = latest.get(userIds.get(otherName)!)!;
    const wrongTurnSocket = sockets.get(otherName)!;
    const wrongTurnError = waitEvent<{ code: string; message: string }>(
      wrongTurnSocket,
      'error',
      (payload) => payload?.code === 'E_TURN',
    );
    const wrongTurnAck = await emitAck<{ ok: boolean }>(wrongTurnSocket, 'game.action', {
      matchId: firstActor.captured.matchId,
      seq: firstSeq,
      actionId: randomUUID(),
      action: {
        type: 'preserve',
        cardId: otherView.view.you!.hand[0]!.id,
      },
    });
    assert.equal(wrongTurnAck.ok, true);
    await wrongTurnError;

    // Play a full game using only preservation actions. Every player has
    // enough non-culprit cards for this to be legal until one card remains.
    for (let step = 0; step < 100 && !resultPayload; step += 1) {
      if (step === 2 && !bobReconnected) {
        bobReconnected = true;
        const bobId = userIds.get('Bob')!;
        const oldSocket = sockets.get('Bob')!;
        oldSocket.close();
        await delay(50);
        const newSocket = await connect(base, cookies.get('Bob')!);
        sockets.set('Bob', newSocket);
        attach(bobId, newSocket);
        const resent = waitEvent<CapturedView>(newSocket, 'game.view');
        assert.deepEqual(await emitAck(newSocket, 'room.subscribe', { roomId }), { ok: true });
        const view = await resent;
        assert.equal(view.view.you?.userId, bobId);
        assert.ok((view.view.you?.hand.length ?? 0) >= 1);
        await waitFor(() => latest.get(bobId)?.view.phase !== undefined, 5000);
      }

      const actor = current();
      if (!actor) {
        await delay(30);
        continue;
      }
      const preserve = actor.captured.actions.find((action) => action.type === 'preserve');
      assert.ok(preserve, 'expected a preserve action');
      const seqBefore = actor.captured.seq;
      const ack = await emitAck<{ ok: boolean; error?: string }>(
        sockets.get(['Alice', 'Bob', 'Carol'].find((name) => userIds.get(name) === actor.id)!)!,
        'game.action',
        {
          matchId: actor.captured.matchId,
          seq: seqBefore,
          actionId: randomUUID(),
          action: preserve,
        },
      );
      assert.equal(ack.ok, true, JSON.stringify(ack));
      await waitFor(
        () => (latest.get(actor.id)?.seq ?? 0) > seqBefore || resultPayload !== null,
        8000,
      );
    }

    assert.ok(resultPayload, 'expected game.result');
    const result = resultPayload as ResultPayload;
    assert.ok(Array.isArray(result.result.winners));
    assert.equal(result.result.winners.every((id) => typeof id === 'string'), true);
    assert.equal(result.result.winners.every((id) => playerIds.includes(id)), true);
    assert.equal(typeof result.result.success, 'boolean');
    assert.match(result.result.reason, /胜利|失败/);

    await waitFor(
      () =>
        playerIds.every((id) => latest.get(id)?.view.phase === 'finished'),
      8000,
    );

    for (const name of ['Alice', 'Bob', 'Carol'] as const) {
      const captured = latest.get(userIds.get(name)!)!;
      assert.equal(captured.view.status, 'finished');
      assert.ok(captured.view.result);
      assert.ok(Array.isArray(captured.view.piles.preservation.cards));
      assert.equal(
        captured.view.players.every((player) => player.identity !== undefined),
        true,
      );
      assert.equal(
        captured.view.piles.accusations.reduce((sum, pile) => sum + pile.count, 0) >= 0,
        true,
      );
    }

    await waitFor(() => latest.get(daveId)?.view.phase === 'finished', 8000);
    const finalSpectator = latest.get(daveId)!;
    assert.equal(finalSpectator.view.you, null);
    assert.equal(
      finalSpectator.view.players.every((player) => player.identity !== undefined),
      true,
    );
    assert.equal(
      finalSpectator.view.players.every((player) => player.hand?.length === 1),
      true,
    );

    // Stats count the match once; winners are recorded exactly once.
    for (const name of ['Alice', 'Bob', 'Carol'] as const) {
      const stats = await api(base, '/api/stats/me', cookies.get(name)!);
      assert.equal(stats.total, 1, `${name} total`);
      const iceRows = stats.byGame.filter((row: { gameId: string }) => row.gameId === 'ice');
      const wins = iceRows
        .filter((row: { outcome: string }) => row.outcome === 'win')
        .reduce((sum: number, row: { count: number }) => sum + Number(row.count), 0);
      const expectedWin = result.result.winners.includes(userIds.get(name)!) ? 1 : 0;
      assert.equal(wins, expectedWin, `${name} wins`);
    }

    // The second catalog entry uses the same worker with chaos rules.
    const chaosCreated = await api(base, '/api/rooms', aliceCookie, {
      method: 'POST',
      body: JSON.stringify({ gameId: 'ice-chaos', name: 'ice chaos e2e' }),
    });
    const chaosRoomId = chaosCreated.room.id as string;
    await api(base, `/api/rooms/${chaosRoomId}/join`, bobCookie, { method: 'POST', body: '{}' });
    await api(base, `/api/rooms/${chaosRoomId}/join`, carolCookie, { method: 'POST', body: '{}' });
    for (const name of ['Alice', 'Bob', 'Carol'] as const) {
      assert.deepEqual(
        await emitAck(sockets.get(name)!, 'room.subscribe', { roomId: chaosRoomId }),
        { ok: true },
      );
    }
    await readyAll(base, chaosRoomId, [aliceCookie, bobCookie, carolCookie]);
    await api(base, `/api/rooms/${chaosRoomId}/start`, aliceCookie, {
      method: 'POST',
      body: '{}',
    });
    await waitFor(
      () =>
        playerIds.every((id) => {
          const captured = latest.get(id);
          return (
            captured?.view.config?.mode === 'chaos' &&
            (captured.view.phase === 'waiting' || captured.view.phase === 'playing')
          );
        }),
      12_000,
    );
    for (const name of ['Alice', 'Bob', 'Carol'] as const) {
      const captured = latest.get(userIds.get(name)!)!;
      assert.equal(captured.view.config.mode, 'chaos');
      sockets.get(name)!.emit('game.ready', { matchId: captured.matchId });
    }
    await waitFor(
      () =>
        playerIds.every((id) => latest.get(id)?.view.phase === 'playing'),
      12_000,
    );
    const chaosView = latest.get(playerIds[0]!)!;
    assert.equal(chaosView.view.config.mode, 'chaos');
    assert.equal(chaosView.view.you?.hand.length, 6);
    assert.equal(chaosView.view.config.decisionTimeoutMs, 20_000);

    // The spectator's stats were never touched.
    const daveStats = await api(base, '/api/stats/me', daveCookie);
    assert.equal(daveStats.total, 0);
  } finally {
    for (const socket of sockets.values()) socket.close();
    await platform.close();
  }
});
