import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { parse as parseCookie, serialize as serializeCookie } from 'cookie';
import {
  deleteSession,
  findSessionUser,
  getUserByEmail,
  getUserByName,
  insertSession,
  insertUser,
  type Db,
  type SessionUser,
  type UserRecord,
} from './db.js';

export const SESSION_COOKIE = 'kwibaka_sid';
export const NAME_PATTERN = /^[\x21-\x7E]{1,32}$/;

export interface AuthedUser extends SessionUser {}

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  avatar: string | null;
  isAdmin: boolean;
  nameChangeRequired: boolean;
}

export function normalizeName(name: string): string {
  return name.trim();
}

export function isValidName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return (
    email.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  );
}

export function hashSecret(secret: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(secret, salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifySecret(secret: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(secret, Buffer.from(saltHex, 'hex'), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// Kept as aliases for code that used the old invite-code naming.
export const hashCode = hashSecret;
export const verifyCode = verifySecret;

export function generateInviteCode(): string {
  return randomBytes(18).toString('base64url');
}

export interface CreateUserOptions {
  email?: string;
  password?: string;
  isAdmin?: boolean;
  verified?: boolean;
}

/** Test/CLI helper: creates a verified user with a deterministic test email. */
export function createUser(
  db: Db,
  name: string,
  code?: string,
  options: CreateUserOptions = {},
): { user: SessionUser; code: string } {
  const normalized = normalizeName(name);
  if (!isValidName(normalized)) {
    throw new Error('name must be 1-32 visible ASCII characters');
  }
  if (getUserByName(db, normalized)) throw new Error('name already exists');
  const email = normalizeEmail(options.email || `${slug(normalized)}@test.local`);
  if (!isValidEmail(email)) throw new Error('invalid email');
  if (getUserByEmail(db, email)) throw new Error('email already exists');
  const inviteCode = code?.trim() || generateInviteCode();
  if (inviteCode.length < 6) throw new Error('password must be at least 6 characters');
  const id = randomUUID();
  const isAdmin = options.isAdmin ?? false;
  insertUser(db, {
    id,
    name: normalized,
    email,
    password_hash: hashSecret(inviteCode),
    email_verified: options.verified === false ? 0 : 1,
    avatar: null,
    is_admin: isAdmin ? 1 : 0,
    name_change_required: 0,
    disabled: 0,
    ban_reason: null,
    created_at: Date.now(),
  });
  return {
    user: { id, name: normalized, nameChangeRequired: false },
    code: inviteCode,
  };
}

export function createUnverifiedUser(
  db: Db,
  name: string,
  email: string,
  password: string,
  isAdmin: boolean,
): UserRecord {
  const normalized = normalizeName(name);
  if (!isValidName(normalized)) throw new Error('name must be 1-32 visible ASCII characters');
  if (getUserByName(db, normalized)) throw new Error('name already exists');
  const normalizedEmail = normalizeEmail(email);
  if (!isValidEmail(normalizedEmail)) throw new Error('invalid email');
  if (getUserByEmail(db, normalizedEmail)) throw new Error('email already exists');
  if (password.length < 6) throw new Error('password must be at least 6 characters');
  const user: UserRecord = {
    id: randomUUID(),
    name: normalized,
    email: normalizedEmail,
    password_hash: hashSecret(password),
    email_verified: 0,
    avatar: null,
    is_admin: isAdmin ? 1 : 0,
    name_change_required: 0,
    disabled: 0,
    ban_reason: null,
    created_at: Date.now(),
  };
  insertUser(db, user);
  return user;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'user';
}

export function publicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    avatar: user.avatar,
    isAdmin: !!user.is_admin,
    nameChangeRequired: !!user.name_change_required,
  };
}

export interface SessionUserWithFlag extends SessionUser {}

export function createSession(db: Db, userId: string, ttlMs: number): string {
  const token = randomBytes(32).toString('base64url');
  const id = sessionIdForToken(token);
  insertSession(db, id, userId, Date.now() + ttlMs);
  return token;
}

export function destroySession(db: Db, token: string | undefined): void {
  if (!token) return;
  deleteSession(db, sessionIdForToken(token));
}

export function sessionCookie(token: string, maxAgeMs: number, secure: boolean): string {
  return serializeCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: Math.floor(maxAgeMs / 1000),
  });
}

export function clearSessionCookie(secure: boolean): string {
  return serializeCookie(SESSION_COOKIE, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: 0,
  });
}

export function readCookie(req: Request, name: string): string | undefined {
  return readCookieHeader(req.headers.cookie, name);
}

export function readCookieHeader(header: string | undefined, name: string): string | undefined {
  return parseCookie(header ?? '')[name];
}

export function sessionIdForToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function userFromCookieHeader(db: Db, header: string | undefined): SessionUser | null {
  const token = readCookieHeader(header, SESSION_COOKIE);
  if (!token) return null;
  return findSessionUser(db, sessionIdForToken(token));
}

export function authMiddleware(db: Db) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) {
      res.status(401).json({ error: 'not logged in' });
      return;
    }
    const user = findSessionUser(db, sessionIdForToken(token));
    if (!user) {
      res.status(401).json({ error: 'session expired' });
      return;
    }
    res.locals.user = user;
    next();
  };
}

export function currentUser(res: Response): AuthedUser {
  const user = res.locals.user as AuthedUser | undefined;
  if (!user) throw new Error('currentUser called without auth');
  return user;
}
