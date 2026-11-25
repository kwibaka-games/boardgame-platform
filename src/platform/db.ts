import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

export interface UserRecord {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  email_verified: number;
  avatar: string | null;
  is_admin: number;
  name_change_required: number;
  disabled: number;
  ban_reason: string | null;
  created_at: number;
}

export interface SessionUser {
  id: string;
  name: string;
  nameChangeRequired: boolean;
}

export interface EmailVerificationRecord {
  id: string;
  user_id: string;
  email: string;
  code_hash: string;
  purpose: 'register' | 'change';
  expires_at: number;
  created_at: number;
  consumed_at: number | null;
}

export interface RoomRecord {
  id: string;
  name: string;
  game_id: string;
  owner_id: string;
  status: 'waiting' | 'starting' | 'playing' | 'finished';
  seats_json: string;
  settings_json: string;
  password_hash: string | null;
  match_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface ChatRecord {
  id: string;
  room_id: string;
  user_id: string;
  name: string;
  text: string;
  ts: number;
  role: 'player' | 'spectator';
}

export function openDb(dbPath: string): Db {
  if (dbPath !== ':memory:') {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function tableColumns(db: Db, table: string): { name: string }[] {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
  } catch {
    return [];
  }
}

function migrate(db: Db): void {
  // v2 auth: the old invite-code users are intentionally removed. Current
  // installations are test deployments, and the user asked to start clean.
  const userColumns = tableColumns(db, 'users');
  if (userColumns.length > 0 && !userColumns.some((column) => column.name === 'email')) {
    db.exec(`
      DROP TABLE IF EXISTS email_verifications;
      DROP TABLE IF EXISTS sessions;
      DROP TABLE IF EXISTS chat_messages;
      DROP TABLE IF EXISTS match_players;
      DROP TABLE IF EXISTS matches;
      DROP TABLE IF EXISTS rooms;
      DROP TABLE IF EXISTS users;
    `);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id                    TEXT PRIMARY KEY,
      name                  TEXT NOT NULL UNIQUE COLLATE NOCASE,
      email                 TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash         TEXT NOT NULL,
      email_verified        INTEGER NOT NULL DEFAULT 0,
      avatar                TEXT,
      is_admin              INTEGER NOT NULL DEFAULT 0,
      name_change_required  INTEGER NOT NULL DEFAULT 0,
      disabled              INTEGER NOT NULL DEFAULT 0,
      ban_reason            TEXT,
      created_at            INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS email_verifications (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      email       TEXT NOT NULL COLLATE NOCASE,
      code_hash   TEXT NOT NULL,
      purpose     TEXT NOT NULL,
      expires_at  INTEGER NOT NULL,
      created_at  INTEGER NOT NULL,
      consumed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_email_verifications_user
      ON email_verifications(user_id, purpose, created_at DESC);

    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS rooms (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      game_id       TEXT NOT NULL,
      owner_id      TEXT NOT NULL,
      status        TEXT NOT NULL,
      seats_json    TEXT NOT NULL,
      settings_json TEXT NOT NULL DEFAULT '{}',
      password_hash TEXT,
      match_id      TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rooms_status ON rooms(status, created_at DESC);

    CREATE TABLE IF NOT EXISTS chat_messages (
      id      TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      name    TEXT NOT NULL,
      text    TEXT NOT NULL,
      ts      INTEGER NOT NULL,
      role    TEXT NOT NULL DEFAULT 'player'
    );
    CREATE INDEX IF NOT EXISTS idx_chat_room ON chat_messages(room_id, ts DESC);

    CREATE TABLE IF NOT EXISTS matches (
      id          TEXT PRIMARY KEY,
      room_id     TEXT NOT NULL,
      game_id     TEXT NOT NULL,
      started_at  INTEGER NOT NULL,
      ended_at    INTEGER,
      result_json TEXT,
      status      TEXT NOT NULL DEFAULT 'playing',
      error       TEXT
    );

    CREATE TABLE IF NOT EXISTS match_players (
      match_id TEXT NOT NULL,
      user_id  TEXT NOT NULL,
      seat     INTEGER NOT NULL,
      outcome  TEXT,
      PRIMARY KEY (match_id, user_id)
    );
  `);

  // Forward-compatible columns for databases that already have the new users
  // table but were created by an intermediate build.
  const roomColumns = tableColumns(db, 'rooms');
  if (!roomColumns.some((column) => column.name === 'password_hash')) {
    db.exec('ALTER TABLE rooms ADD COLUMN password_hash TEXT');
  }
  if (!roomColumns.some((column) => column.name === 'settings_json')) {
    db.exec("ALTER TABLE rooms ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}'");
  }
  const matchColumns = tableColumns(db, 'matches');
  if (!matchColumns.some((column) => column.name === 'status')) {
    db.exec("ALTER TABLE matches ADD COLUMN status TEXT NOT NULL DEFAULT 'playing'");
  }
  if (!matchColumns.some((column) => column.name === 'error')) {
    db.exec('ALTER TABLE matches ADD COLUMN error TEXT');
  }
  const chatColumns = tableColumns(db, 'chat_messages');
  if (!chatColumns.some((column) => column.name === 'role')) {
    db.exec("ALTER TABLE chat_messages ADD COLUMN role TEXT NOT NULL DEFAULT 'player'");
  }
}

export function getUserByName(db: Db, name: string): UserRecord | null {
  const row = db.prepare('SELECT * FROM users WHERE name = ? COLLATE NOCASE').get(name);
  return (row as UserRecord | undefined) ?? null;
}

export function getUserByEmail(db: Db, email: string): UserRecord | null {
  const row = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(email);
  return (row as UserRecord | undefined) ?? null;
}

export function getUserById(db: Db, id: string): UserRecord | null {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  return (row as UserRecord | undefined) ?? null;
}

export function countUsers(db: Db): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
  return Number(row.n);
}

export function insertUser(db: Db, user: UserRecord): void {
  db.prepare(
    `INSERT INTO users
      (id, name, email, password_hash, email_verified, avatar, is_admin,
       name_change_required, disabled, ban_reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    user.id,
    user.name,
    user.email,
    user.password_hash,
    user.email_verified,
    user.avatar,
    user.is_admin,
    user.name_change_required,
    user.disabled,
    user.ban_reason,
    user.created_at,
  );
}

export type UserPatch = Partial<
  Pick<
    UserRecord,
    | 'name'
    | 'email'
    | 'password_hash'
    | 'email_verified'
    | 'avatar'
    | 'is_admin'
    | 'name_change_required'
    | 'disabled'
    | 'ban_reason'
  >
>;

export function updateUser(db: Db, userId: string, patch: UserPatch): void {
  const keys = Object.keys(patch) as (keyof UserPatch)[];
  if (!keys.length) return;
  const assignments = keys.map((key) => `${key} = ?`).join(', ');
  const values = keys.map((key) => patch[key] ?? null);
  db.prepare(`UPDATE users SET ${assignments} WHERE id = ?`).run(...values, userId);
}

export function listUsers(db: Db, search = '', limit = 100): UserRecord[] {
  const term = `%${search.trim()}%`;
  return db
    .prepare(
      `SELECT * FROM users
       WHERE ? = '%%' OR name LIKE ? OR email LIKE ?
       ORDER BY is_admin DESC, created_at ASC LIMIT ?`,
    )
    .all(term, term, term, limit) as unknown as UserRecord[];
}

export function deleteSessionsForUser(db: Db, userId: string): void {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function insertEmailVerification(
  db: Db,
  record: EmailVerificationRecord,
): void {
  db.prepare(
    `INSERT INTO email_verifications
      (id, user_id, email, code_hash, purpose, expires_at, created_at, consumed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id,
    record.user_id,
    record.email,
    record.code_hash,
    record.purpose,
    record.expires_at,
    record.created_at,
    record.consumed_at,
  );
}

export function latestEmailVerification(
  db: Db,
  userId: string,
  email: string,
  purpose: 'register' | 'change',
): EmailVerificationRecord | null {
  const row = db
    .prepare(
      `SELECT * FROM email_verifications
       WHERE user_id = ? AND email = ? COLLATE NOCASE AND purpose = ?
         AND consumed_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(userId, email, purpose, Date.now());
  return (row as EmailVerificationRecord | undefined) ?? null;
}

export function consumeEmailVerification(db: Db, id: string): void {
  db.prepare('UPDATE email_verifications SET consumed_at = ? WHERE id = ?').run(Date.now(), id);
}

export function clearEmailVerifications(
  db: Db,
  userId: string,
  purpose?: 'register' | 'change',
): void {
  if (purpose) {
    db.prepare('DELETE FROM email_verifications WHERE user_id = ? AND purpose = ?').run(userId, purpose);
  } else {
    db.prepare('DELETE FROM email_verifications WHERE user_id = ?').run(userId);
  }
}

export function emailIsTaken(db: Db, email: string, exceptUserId?: string): boolean {
  const row = exceptUserId
    ? db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE AND id <> ?').get(email, exceptUserId)
    : db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE').get(email);
  return !!row;
}

export function pendingEmailIsTaken(db: Db, email: string, exceptUserId?: string): boolean {
  const row = exceptUserId
    ? db
        .prepare(
          `SELECT 1 FROM email_verifications
           WHERE email = ? COLLATE NOCASE AND purpose = 'change' AND consumed_at IS NULL
             AND expires_at > ? AND user_id <> ?`,
        )
        .get(email, Date.now(), exceptUserId)
    : db
        .prepare(
          `SELECT 1 FROM email_verifications
           WHERE email = ? COLLATE NOCASE AND purpose = 'change' AND consumed_at IS NULL
             AND expires_at > ?`,
        )
        .get(email, Date.now());
  return !!row;
}

export function insertSession(db: Db, id: string, userId: string, expiresAt: number): void {
  db.prepare(
    'INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
  ).run(id, userId, expiresAt, Date.now());
}

export function findSessionUser(db: Db, sessionId: string): SessionUser | null {
  const row = db
    .prepare(
      `SELECT u.id AS id, u.name AS name, u.name_change_required AS name_change_required,
              s.expires_at AS expires_at, u.disabled AS disabled
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ?`,
    )
    .get(sessionId) as
    | {
        id: string;
        name: string;
        name_change_required: number;
        expires_at: number;
        disabled: number;
      }
    | undefined;

  if (!row) return null;
  if (row.expires_at <= Date.now() || row.disabled) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    return null;
  }
  return { id: row.id, name: row.name, nameChangeRequired: !!row.name_change_required };
}

export function deleteSession(db: Db, sessionId: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

export function deleteExpiredSessions(db: Db): void {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
}

export function getRoom(db: Db, roomId: string): RoomRecord | null {
  const row = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
  return (row as RoomRecord | undefined) ?? null;
}

export function listRooms(db: Db, limit = 50): RoomRecord[] {
  return db
    .prepare(
      `SELECT * FROM rooms
       WHERE status IN ('waiting', 'starting', 'playing')
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit) as unknown as RoomRecord[];
}

export function insertRoom(db: Db, room: RoomRecord): void {
  db.prepare(
    `INSERT INTO rooms
      (id, name, game_id, owner_id, status, seats_json, settings_json, password_hash,
       match_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    room.id,
    room.name,
    room.game_id,
    room.owner_id,
    room.status,
    room.seats_json,
    room.settings_json,
    room.password_hash,
    room.match_id,
    room.created_at,
    room.updated_at,
  );
}

export function updateRoom(
  db: Db,
  roomId: string,
  patch: Partial<
    Pick<
      RoomRecord,
      'status' | 'seats_json' | 'settings_json' | 'owner_id' | 'match_id' | 'name' | 'password_hash'
    >
  >,
): void {
  const current = getRoom(db, roomId);
  if (!current) return;
  const next = { ...current, ...patch, updated_at: Date.now() };
  db.prepare(
    `UPDATE rooms SET name = ?, owner_id = ?, status = ?, seats_json = ?, settings_json = ?,
       password_hash = ?, match_id = ?, updated_at = ? WHERE id = ?`,
  ).run(
    next.name,
    next.owner_id,
    next.status,
    next.seats_json,
    next.settings_json,
    next.password_hash,
    next.match_id,
    next.updated_at,
    roomId,
  );
}

export function deleteRoom(db: Db, roomId: string): void {
  db.prepare('DELETE FROM rooms WHERE id = ?').run(roomId);
  db.prepare('DELETE FROM chat_messages WHERE room_id = ?').run(roomId);
}

export function insertChat(db: Db, message: ChatRecord): void {
  db.prepare(
    'INSERT INTO chat_messages (id, room_id, user_id, name, text, ts, role) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    message.id,
    message.room_id,
    message.user_id,
    message.name,
    message.text,
    message.ts,
    message.role,
  );
}

export function listChat(db: Db, roomId: string, limit = 100): ChatRecord[] {
  const rows = db
    .prepare(
      `SELECT * FROM chat_messages WHERE room_id = ? ORDER BY ts DESC LIMIT ?`,
    )
    .all(roomId, limit) as unknown as ChatRecord[];
  return rows.reverse();
}

export function insertMatch(
  db: Db,
  match: { id: string; roomId: string; gameId: string; seats: { userId: string; seat: number }[] },
): void {
  db.prepare(
    "INSERT INTO matches (id, room_id, game_id, started_at, ended_at, result_json, status) VALUES (?, ?, ?, ?, NULL, NULL, 'playing')",
  ).run(match.id, match.roomId, match.gameId, Date.now());
  const stmt = db.prepare(
    'INSERT OR REPLACE INTO match_players (match_id, user_id, seat, outcome) VALUES (?, ?, ?, NULL)',
  );
  for (const seat of match.seats) {
    stmt.run(match.id, seat.userId, seat.seat);
  }
}

export function markMatchAborted(
  db: Db,
  matchId: string,
  status: 'aborted' | 'crashed',
  error: string,
): void {
  db.prepare(
    "UPDATE matches SET ended_at = ?, status = ?, error = ? WHERE id = ? AND status = 'playing'",
  ).run(Date.now(), status, error, matchId);
}

export function abortUnfinishedMatches(db: Db): void {
  db.prepare(
    "UPDATE matches SET ended_at = ?, status = 'aborted', error = 'platform_restart' WHERE status = 'playing'",
  ).run(Date.now());
}

export function finishMatch(
  db: Db,
  matchId: string,
  result: unknown,
  winners: string[],
): void {
  db.prepare(
    "UPDATE matches SET ended_at = ?, result_json = ?, status = 'finished', error = NULL WHERE id = ?",
  ).run(Date.now(), JSON.stringify(result ?? null), matchId);
  const rows = db
    .prepare('SELECT user_id FROM match_players WHERE match_id = ?')
    .all(matchId) as unknown as { user_id: string }[];
  const winnerSet = new Set(winners);
  for (const row of rows) {
    db.prepare('UPDATE match_players SET outcome = ? WHERE match_id = ? AND user_id = ?').run(
      winnerSet.has(row.user_id) ? 'win' : 'lose',
      matchId,
      row.user_id,
    );
  }
}
