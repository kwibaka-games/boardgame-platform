import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig, type Config } from '../src/platform/config.js';
import { createPlatform, type Platform } from '../src/platform/server.js';
import { openDb } from '../src/platform/db.js';
import { createUser } from '../src/platform/auth.js';

function testConfig(): Config {
  return {
    ...loadConfig(),
    port: 0,
    host: '127.0.0.1',
    dbPath: ':memory:',
    webDir: new URL('../web', import.meta.url).pathname,
    publicOrigin: null,
    publicOrigins: [],
    cookieSecure: false,
    sessionTtlMs: 60 * 60 * 1000,
    gameSecret: 'accounts-test-secret',
    loginRateLimit: 100,
    emailDebug: true,
    smtpHost: null,
    adminEmail: null,
  };
}

interface Response {
  status: number;
  body: any;
  cookie: string | null;
}

async function request(base: string, path: string, init: RequestInit = {}, cookie?: string): Promise<Response> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  const setCookie = response.headers.getSetCookie()[0];
  return { status: response.status, body, cookie: setCookie ? setCookie.split(';')[0]! : null };
}

function json(body: unknown): RequestInit {
  return { method: 'POST', body: JSON.stringify(body) };
}

async function register(base: string, email: string, name: string, password: string) {
  const result = await request(base, '/api/auth/register', json({ email, name, password }));
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(typeof result.body.debugCode, 'string');
  return result.body.debugCode as string;
}

async function verify(base: string, email: string, code: string) {
  const result = await request(base, '/api/auth/verify-email', json({ email, code }));
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.ok(result.cookie);
  return { cookie: result.cookie!, user: result.body.user };
}

async function login(base: string, email: string, password: string) {
  const result = await request(base, '/api/auth/login', json({ email, password }));
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result;
}

test('email registration, verification, admin, ban, force rename and email change', async () => {
  const config = testConfig();
  const db = openDb(':memory:');
  const platform: Platform = createPlatform(config, db);
  const base = `http://127.0.0.1:${await platform.listen(0, '127.0.0.1')}`;
  try {
    const aliceCode = await register(base, 'alice@example.test', 'Alice', 'alicepass');
    const unverified = await request(base, '/api/auth/login', json({ email: 'alice@example.test', password: 'alicepass' }));
    assert.equal(unverified.status, 403);
    assert.equal(unverified.body.code, 'EMAIL_UNVERIFIED');
    const alice = await verify(base, 'alice@example.test', aliceCode);
    assert.equal(alice.user.name, 'Alice');
    assert.equal(alice.user.isAdmin, true);

    const bobCode = await register(base, 'bob@example.test', 'Bob', 'bobpass1');
    const bob = await verify(base, 'bob@example.test', bobCode);
    assert.equal(bob.user.isAdmin, false);

    const duplicateEmail = await request(base, '/api/auth/register', json({
      email: 'bob@example.test',
      name: 'Bobby',
      password: 'longpass',
    }));
    assert.equal(duplicateEmail.status, 400);

    const list = await request(base, '/api/admin/users', {}, alice.cookie);
    assert.equal(list.status, 200);
    assert.equal(list.body.users.length, 2);

    const ban = await request(base, `/api/admin/users/${bob.user.id}/ban`, json({ disabled: true, reason: 'test' }), alice.cookie);
    assert.equal(ban.status, 200);
    const bannedMe = await request(base, '/api/me', {}, bob.cookie);
    assert.equal(bannedMe.status, 401);
    const bannedLogin = await request(base, '/api/auth/login', json({ email: 'bob@example.test', password: 'bobpass1' }));
    assert.equal(bannedLogin.status, 403);

    const unban = await request(base, `/api/admin/users/${bob.user.id}/ban`, json({ disabled: false }), alice.cookie);
    assert.equal(unban.status, 200);
    const bobAgain = await login(base, 'bob@example.test', 'bobpass1');

    const force = await request(base, `/api/admin/users/${bob.user.id}/force-rename`, json({}), alice.cookie);
    assert.equal(force.status, 200);
    const blocked = await request(base, '/api/games', {}, bobAgain.cookie);
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, 'NAME_CHANGE_REQUIRED');
    const renamed = await request(base, '/api/me/name', { method: 'PATCH', body: JSON.stringify({ name: 'BobNew' }) }, bobAgain.cookie);
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.user.name, 'BobNew');
    assert.equal((await request(base, '/api/games', {}, bobAgain.cookie)).status, 200);

    const changed = await request(base, '/api/me/email/change', json({
      email: 'alice2@example.test',
      password: 'alicepass',
    }), alice.cookie);
    assert.equal(changed.status, 200);
    const changeCode = changed.body.debugCode as string;
    const proveChange = await request(base, '/api/me/email/verify', json({
      email: 'alice2@example.test',
      code: changeCode,
    }), alice.cookie);
    assert.equal(proveChange.status, 200);
    assert.equal(proveChange.body.user.email, 'alice2@example.test');
    assert.equal((await request(base, '/api/auth/login', json({ email: 'alice@example.test', password: 'alicepass' }))).status, 401);
    await login(base, 'alice2@example.test', 'alicepass');

    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z1GQAAAAASUVORK5CYII=';
    const avatar = await request(base, '/api/me/avatar', { method: 'PATCH', body: JSON.stringify({ dataUrl: png }) }, alice.cookie);
    assert.equal(avatar.status, 200);
    assert.equal(avatar.body.user.avatar, png);
    const badAvatar = await request(base, '/api/me/avatar', { method: 'PATCH', body: JSON.stringify({ dataUrl: 'data:text/html;base64,abc' }) }, alice.cookie);
    assert.equal(badAvatar.status, 400);
  } finally {
    await platform.close();
  }
});

test('room passwords, readiness, kick and duplicate joins', async () => {
  const config = testConfig();
  const db = openDb(':memory:');
  const alice = createUser(db, 'RoomAlice', 'roompass1');
  const bob = createUser(db, 'RoomBob', 'roompass2');
  const carol = createUser(db, 'RoomCarol', 'roompass3');
  const platform: Platform = createPlatform(config, db);
  const base = `http://127.0.0.1:${await platform.listen(0, '127.0.0.1')}`;
  try {
    const aliceLogin = await login(base, 'roomalice@test.local', 'roompass1');
    const bobLogin = await login(base, 'roombob@test.local', 'roompass2');
    const carolLogin = await login(base, 'roomcarol@test.local', 'roompass3');

    const created = await request(base, '/api/rooms', json({
      gameId: 'ice',
      name: 'locked room',
      password: '123456',
    }), aliceLogin.cookie);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.room.hasPassword, true);
    const roomId = created.body.room.id as string;

    assert.equal((await request(base, `/api/rooms/${roomId}/join`, json({}), bobLogin.cookie)).status, 400);
    assert.equal((await request(base, `/api/rooms/${roomId}/join`, json({ password: '654321' }), bobLogin.cookie)).status, 400);
    assert.equal((await request(base, `/api/rooms/${roomId}/join`, json({ password: '123456' }), bobLogin.cookie)).status, 200);
    assert.equal((await request(base, `/api/rooms/${roomId}/join`, json({ password: '123456' }), carolLogin.cookie)).status, 200);

    assert.equal((await request(base, `/api/rooms/${roomId}/start`, json({}), aliceLogin.cookie)).status, 400);
    for (const cookie of [aliceLogin.cookie!, bobLogin.cookie!, carolLogin.cookie!]) {
      assert.equal((await request(base, `/api/rooms/${roomId}/ready`, json({ ready: true }), cookie)).status, 200);
    }
    assert.equal((await request(base, `/api/rooms/${roomId}/start`, json({}), aliceLogin.cookie)).status, 200);

    const kickedRoom = await request(base, '/api/rooms', json({ gameId: 'ice' }), aliceLogin.cookie);
    const kickedRoomId = kickedRoom.body.room.id as string;
    await request(base, `/api/rooms/${kickedRoomId}/join`, json({}), bobLogin.cookie);
    await request(base, `/api/rooms/${kickedRoomId}/join`, json({}), carolLogin.cookie);
    const kick = await request(base, `/api/rooms/${kickedRoomId}/kick`, json({ userId: bob.user.id }), aliceLogin.cookie);
    assert.equal(kick.status, 200);
    const afterKick = await request(base, `/api/rooms/${kickedRoomId}`, {}, aliceLogin.cookie);
    assert.equal(afterKick.body.room.players.length, 2);
    assert.equal(afterKick.body.room.players.some((player: { userId: string }) => player.userId === bob.user.id), false);
    assert.equal(alice.user.id.length > 0, true);
    assert.equal(carol.user.id.length > 0, true);
  } finally {
    await platform.close();
  }
});

test('registration is limited per email, not by shared campus/NAT IP', async () => {
  const config = testConfig();
  const db = openDb(':memory:');
  const platform: Platform = createPlatform(config, db);
  const base = `http://127.0.0.1:${await platform.listen(0, '127.0.0.1')}`;
  try {
    for (let i = 0; i < 7; i += 1) {
      const result = await request(base, '/api/auth/register', json({
        email: `shared-ip-${i}@example.test`,
        name: `SharedIp${i}`,
        password: 'sharedpass1',
      }));
      assert.equal(result.status, 201, `registration ${i}: ${JSON.stringify(result.body)}`);
    }
  } finally {
    await platform.close();
  }
});
