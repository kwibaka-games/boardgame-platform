import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import express, { type NextFunction, type Request, type Response } from 'express';
import { Server as SocketServer } from 'socket.io';
import type { DefaultEventsMap } from 'socket.io';
import {
  adminBanSchema,
  changeAvatarSchema,
  changeEmailSchema,
  changeEmailVerifySchema,
  changeNameSchema,
  chatTextSchema,
  createRoomSchema,
  gameActionEnvelopeSchema,
  joinRoomSchema,
  loginSchema,
  registerSchema,
  roomReadySchema,
  verifyEmailSchema,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from '../protocol/protocol.js';
import {
  clearSessionCookie,
  createSession,
  createUnverifiedUser,
  currentUser,
  destroySession,
  hashSecret,
  isValidName,
  normalizeEmail,
  normalizeName,
  publicUser,
  readCookie,
  SESSION_COOKIE,
  sessionCookie,
  userFromCookieHeader,
  verifySecret,
  authMiddleware,
  type AuthedUser,
} from './auth.js';
import {
  clearEmailVerifications,
  consumeEmailVerification,
  countUsers,
  deleteSessionsForUser,
  emailIsTaken,
  getRoom,
  getUserByEmail,
  getUserById,
  getUserByName,
  insertEmailVerification,
  latestEmailVerification,
  listUsers,
  openDb,
  pendingEmailIsTaken,
  updateUser,
  type Db,
} from './db.js';
import { createMailer, generateEmailCode } from './email.js';
import { GameCatalog } from './game-catalog.js';
import { WorkerManager } from './worker-manager.js';
import { WorkerHub } from './worker-hub.js';
import { RoomService, type SocketData } from './rooms.js';
import type { Config } from './config.js';

const userChannel = (userId: string) => `user:${userId}`;

export interface Platform {
  app: express.Express;
  httpServer: HttpServer;
  io: SocketServer<ClientToServerEvents, ServerToClientEvents, DefaultEventsMap, SocketData>;
  db: Db;
  catalog: GameCatalog;
  workers: WorkerManager;
  workerHub: WorkerHub;
  rooms: RoomService;
  listen: (port?: number, host?: string) => Promise<number>;
  close: () => Promise<void>;
}

function publicOrigins(config: Config): string[] {
  const list = config.publicOrigins ?? [];
  if (list.length) return list;
  return config.publicOrigin ? [config.publicOrigin] : [];
}

function allowedOrigin(config: Config, origin: string | undefined): boolean {
  if (!origin) return true;
  const origins = publicOrigins(config);
  if (!origins.length) return true;
  return origins.includes(origin);
}

function sameOrigin(req: Request, config: Config): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  const origins = publicOrigins(config);
  if (origins.length) return origins.includes(origin);
  const host = req.headers.host;
  return origin === `http://${host}` || origin === `https://${host}`;
}

export function createPlatform(config: Config, db = openDb(config.dbPath)): Platform {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '512kb' }));
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'",
    );
    next();
  });

  const loginAttempts = new Map<string, number[]>();
  const loginLimited = (ip: string): boolean => {
    const now = Date.now();
    const recent = (loginAttempts.get(ip) ?? []).filter((ts) => now - ts < 5 * 60_000);
    recent.push(now);
    loginAttempts.set(ip, recent);
    return recent.length > config.loginRateLimit;
  };

  const requireOrigin = (req: Request, res: Response, next: NextFunction): void => {
    if (!sameOrigin(req, config)) {
      res.status(403).json({ error: 'origin not allowed' });
      return;
    }
    next();
  };

  const httpServer = createServer(app);

  const catalog = new GameCatalog();
  const logDir = path.join(
    path.dirname(config.dbPath === ':memory:' ? path.resolve('data', 'platform.db') : config.dbPath),
    'logs',
  );
  const workers = new WorkerManager(config.gameSecret, logDir);

  const io = new SocketServer<ClientToServerEvents, ServerToClientEvents, DefaultEventsMap, SocketData>(
    httpServer,
    {
      cors: {
        origin: (origin, callback) => callback(null, allowedOrigin(config, origin)),
        credentials: true,
      },
      maxHttpBufferSize: 64 * 1024,
      pingInterval: 25_000,
      pingTimeout: 60_000,
    },
  );

  let roomService!: RoomService;
  const workerHub = new WorkerHub(
    config.gameSecret,
    catalog,
    (matchId, gameId) => roomService.handleWorkerRegister(matchId, gameId),
    (matchId, gameId, message) => roomService.handleGameMessage(gameId, message),
    (matchId, reason) => roomService.handleWorkerCrash(matchId, reason),
  );
  roomService = new RoomService(db, io, catalog, workers, workerHub);

  const mailer = createMailer(config);
  const authAttempts = new Map<string, number[]>();
  const rateLimited = (key: string, limit = 20, windowMs = 10 * 60_000): boolean => {
    const now = Date.now();
    const recent = (authAttempts.get(key) ?? []).filter((ts) => now - ts < windowMs);
    recent.push(now);
    authAttempts.set(key, recent);
    return recent.length > limit;
  };

  const profileReady = (_req: Request, res: Response, next: NextFunction): void => {
    if (currentUser(res).nameChangeRequired) {
      res.status(403).json({ error: '管理员要求你先修改用户名', code: 'NAME_CHANGE_REQUIRED' });
      return;
    }
    next();
  };

  const adminGate = (_req: Request, res: Response, next: NextFunction): void => {
    const user = getUserById(db, currentUser(res).id);
    if (!user || !user.is_admin) {
      res.status(403).json({ error: '需要管理员权限' });
      return;
    }
    res.locals.adminUser = user;
    next();
  };

  async function issueEmailCode(
    user: { id: string; email: string },
    email: string,
    purpose: 'register' | 'change',
  ): Promise<string> {
    const code = generateEmailCode();
    clearEmailVerifications(db, user.id, purpose);
    insertEmailVerification(db, {
      id: randomUUID(),
      user_id: user.id,
      email,
      code_hash: hashSecret(code),
      purpose,
      expires_at: Date.now() + 15 * 60_000,
      created_at: Date.now(),
      consumed_at: null,
    });
    await mailer.sendVerification(email, code, purpose);
    return code;
  }

  function statsForUser(userId: string) {
    const rows = db
      .prepare(
        `SELECT m.game_id AS gameId,
                SUM(CASE WHEN mp.outcome = 'win' THEN 1 ELSE 0 END) AS wins,
                COUNT(*) AS played
         FROM match_players mp JOIN matches m ON m.id = mp.match_id
         WHERE mp.user_id = ? AND m.status = 'finished'
         GROUP BY m.game_id
         ORDER BY m.game_id`,
      )
      .all(userId) as unknown as { gameId: string; wins: number; played: number }[];
    const legacy = db
      .prepare(
        `SELECT m.game_id AS gameId, mp.outcome AS outcome, COUNT(*) AS count
         FROM match_players mp JOIN matches m ON m.id = mp.match_id
         WHERE mp.user_id = ? AND m.status = 'finished'
         GROUP BY m.game_id, mp.outcome`,
      )
      .all(userId) as unknown as { gameId: string; outcome: string | null; count: number }[];
    const total = legacy.reduce((sum, row) => sum + Number(row.count), 0);
    const wins = rows.reduce((sum, row) => sum + Number(row.wins), 0);
    return {
      total,
      wins,
      winsByGame: rows.map((row) => ({
        gameId: row.gameId,
        wins: Number(row.wins),
        played: Number(row.played),
      })),
      byGame: legacy,
    };
  }

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, games: catalog.list().length, workers: workers.activeCount() });
  });

  app.post('/api/auth/register', requireOrigin, async (req, res) => {
    const ip = req.ip || 'unknown';
    if (rateLimited(`register:${ip}`, 5, 30 * 60_000)) {
      res.status(429).json({ error: '注册尝试过多，请稍后再试' });
      return;
    }
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: '请输入有效邮箱、至少 8 位密码和用户名' });
      return;
    }
    const name = normalizeName(parsed.data.name);
    if (!isValidName(name)) {
      res.status(400).json({ error: '用户名只能是 1-32 个可见 ASCII 字符' });
      return;
    }
    const email = normalizeEmail(parsed.data.email);
    try {
      const isAdmin = config.adminEmail ? email === config.adminEmail : countUsers(db) === 0;
      const user = createUnverifiedUser(db, name, email, parsed.data.password, isAdmin);
      let code: string;
      try {
        code = await issueEmailCode(user, email, 'register');
      } catch (error) {
        res.status(503).json({ error: (error as Error).message });
        return;
      }
      res.status(201).json({
        pending: true,
        email,
        debugCode: config.emailDebug ? code : undefined,
      });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  app.post('/api/auth/verify-email', requireOrigin, (req, res) => {
    const parsed = verifyEmailSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: '请输入邮箱和 6 位验证码' });
      return;
    }
    const email = normalizeEmail(parsed.data.email);
    const user = getUserByEmail(db, email);
    if (!user) {
      res.status(400).json({ error: '验证码无效或已过期' });
      return;
    }
    if (user.disabled) {
      res.status(403).json({ error: '该账号已被封禁' });
      return;
    }
    if (user.email_verified) {
      res.status(409).json({ error: '邮箱已经验证，请直接登录' });
      return;
    }
    const record = latestEmailVerification(db, user.id, email, 'register');
    if (!record || !verifySecret(parsed.data.code, record.code_hash)) {
      res.status(400).json({ error: '验证码无效或已过期' });
      return;
    }
    consumeEmailVerification(db, record.id);
    updateUser(db, user.id, { email_verified: 1 });
    clearEmailVerifications(db, user.id, 'register');
    const token = createSession(db, user.id, config.sessionTtlMs);
    res.setHeader('Set-Cookie', sessionCookie(token, config.sessionTtlMs, config.cookieSecure));
    res.json({ user: publicUser({ ...user, email_verified: 1 }) });
  });

  app.post('/api/auth/resend-verification', requireOrigin, async (req, res) => {
    const ip = req.ip || 'unknown';
    if (rateLimited(`resend:${ip}`, 3, 10 * 60_000)) {
      res.status(429).json({ error: '请求过于频繁，请稍后再试' });
      return;
    }
    const email = normalizeEmail(typeof req.body?.email === 'string' ? req.body.email : '');
    const user = getUserByEmail(db, email);
    if (!user || user.email_verified) {
      res.status(400).json({ error: '该邮箱无需验证' });
      return;
    }
    try {
      const code = await issueEmailCode(user, user.email, 'register');
      res.json({ ok: true, debugCode: config.emailDebug ? code : undefined });
    } catch (error) {
      res.status(503).json({ error: (error as Error).message });
    }
  });

  app.post('/api/auth/login', requireOrigin, (req, res) => {
    const ip = req.ip || 'unknown';
    if (loginLimited(ip)) {
      res.status(429).json({ error: 'too many attempts' });
      return;
    }
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: '请输入邮箱和密码' });
      return;
    }
    const email = normalizeEmail(parsed.data.email);
    const user = getUserByEmail(db, email);
    if (!user || !verifySecret(parsed.data.password, user.password_hash)) {
      res.status(401).json({ error: '邮箱或密码错误' });
      return;
    }
    if (user.disabled) {
      res.status(403).json({ error: '该账号已被封禁' });
      return;
    }
    if (!user.email_verified) {
      res.status(403).json({ error: '请先验证邮箱', code: 'EMAIL_UNVERIFIED' });
      return;
    }
    const token = createSession(db, user.id, config.sessionTtlMs);
    res.setHeader('Set-Cookie', sessionCookie(token, config.sessionTtlMs, config.cookieSecure));
    res.json({ user: publicUser(user) });
  });

  app.post('/api/auth/logout', requireOrigin, (req, res) => {
    destroySession(db, readCookie(req, SESSION_COOKIE));
    res.setHeader('Set-Cookie', clearSessionCookie(config.cookieSecure));
    res.json({ ok: true });
  });

  const auth = authMiddleware(db);
  app.get('/api/me', auth, (_req, res) => {
    const user = getUserById(db, currentUser(res).id);
    if (!user) {
      res.status(401).json({ error: 'session expired' });
      return;
    }
    res.json({ user: publicUser(user) });
  });

  app.patch('/api/me/name', auth, requireOrigin, (req, res) => {
    const parsed = changeNameSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: '用户名格式不正确' });
      return;
    }
    const name = normalizeName(parsed.data.name);
    if (!isValidName(name)) {
      res.status(400).json({ error: '用户名只能是 1-32 个可见 ASCII 字符' });
      return;
    }
    const current = getUserById(db, currentUser(res).id);
    if (!current) {
      res.status(401).json({ error: 'session expired' });
      return;
    }
    if (name === current.name && current.name_change_required) {
      res.status(400).json({ error: '管理员要求更换一个新的用户名' });
      return;
    }
    const existing = getUserByName(db, name);
    if (existing && existing.id !== current.id) {
      res.status(409).json({ error: '用户名已被占用' });
      return;
    }
    updateUser(db, current.id, { name, name_change_required: 0 });
    roomService.updateUserName(current.id, name);
    const updated = getUserById(db, current.id)!;
    res.json({ user: publicUser(updated) });
  });

  app.patch('/api/me/avatar', auth, requireOrigin, (req, res) => {
    const parsed = changeAvatarSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: '头像格式不正确' });
      return;
    }
    const dataUrl = parsed.data.dataUrl;
    if (dataUrl && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) {
      res.status(400).json({ error: '头像必须是 PNG/JPEG/WebP 图片' });
      return;
    }
    updateUser(db, currentUser(res).id, { avatar: dataUrl || null });
    const updated = getUserById(db, currentUser(res).id)!;
    res.json({ user: publicUser(updated) });
  });

  app.post('/api/me/email/change', auth, requireOrigin, async (req, res) => {
    const ip = req.ip || 'unknown';
    if (rateLimited(`email-change:${ip}`, 5, 30 * 60_000)) {
      res.status(429).json({ error: '请求过于频繁，请稍后再试' });
      return;
    }
    const parsed = changeEmailSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: '请输入有效邮箱和当前密码' });
      return;
    }
    const user = getUserById(db, currentUser(res).id);
    if (!user || !verifySecret(parsed.data.password, user.password_hash)) {
      res.status(403).json({ error: '密码错误' });
      return;
    }
    const email = normalizeEmail(parsed.data.email);
    if (email === user.email) {
      res.status(400).json({ error: '新邮箱不能与当前邮箱相同' });
      return;
    }
    if (emailIsTaken(db, email) || pendingEmailIsTaken(db, email, user.id)) {
      res.status(409).json({ error: '该邮箱已被占用' });
      return;
    }
    try {
      const code = await issueEmailCode(user, email, 'change');
      res.json({ pending: true, email, debugCode: config.emailDebug ? code : undefined });
    } catch (error) {
      res.status(503).json({ error: (error as Error).message });
    }
  });

  app.post('/api/me/email/verify', auth, requireOrigin, (req, res) => {
    const parsed = changeEmailVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: '请输入新邮箱和 6 位验证码' });
      return;
    }
    const current = getUserById(db, currentUser(res).id);
    if (!current) {
      res.status(401).json({ error: 'session expired' });
      return;
    }
    const email = normalizeEmail(parsed.data.email);
    if (emailIsTaken(db, email, current.id)) {
      res.status(409).json({ error: '该邮箱已被占用' });
      return;
    }
    const record = latestEmailVerification(db, current.id, email, 'change');
    if (!record || !verifySecret(parsed.data.code, record.code_hash)) {
      res.status(400).json({ error: '验证码无效或已过期' });
      return;
    }
    consumeEmailVerification(db, record.id);
    updateUser(db, current.id, { email, email_verified: 1 });
    clearEmailVerifications(db, current.id, 'change');
    const updated = getUserById(db, current.id)!;
    res.json({ user: publicUser(updated) });
  });

  app.get('/api/games', auth, profileReady, (_req, res) => {
    res.json({ games: roomService.listGames() });
  });

  app.get('/api/rooms', auth, profileReady, (_req, res) => {
    res.json({ rooms: roomService.listOpenRooms() });
  });

  app.post('/api/rooms', auth, profileReady, requireOrigin, (req, res) => {
    const parsed = createRoomSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: '游戏 ID 或房间密码格式不正确' });
      return;
    }
    try {
      const room = roomService.createRoom(
        currentUser(res),
        parsed.data.gameId,
        parsed.data.name,
        parsed.data.password,
      );
      res.status(201).json({ room });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  app.get('/api/rooms/:id', auth, profileReady, (req, res) => {
    const user = currentUser(res);
    const roomId = String(req.params.id ?? '');
    const spectate = req.query.spectate === '1';
    const room = roomService.getRoom(roomId, user.id, spectate);
    if (!room) {
      res.status(404).json({ error: 'room not found' });
      return;
    }
    if (!spectate && !room.players.some((player) => player.userId === user.id)) {
      res.status(403).json({ error: 'not in room' });
      return;
    }
    res.json({ room });
  });

  app.get('/api/rooms/:id/messages', auth, profileReady, (req, res) => {
    const user = currentUser(res);
    const roomId = String(req.params.id ?? '');
    const spectate = req.query.spectate === '1';
    const room = roomService.getRoom(roomId, user.id, spectate);
    if (!room) {
      res.status(404).json({ error: 'room not found' });
      return;
    }
    if (!spectate && !room.players.some((player) => player.userId === user.id)) {
      res.status(403).json({ error: 'not in room' });
      return;
    }
    res.json({ messages: roomService.listMessages(roomId) });
  });

  app.post('/api/rooms/:id/join', auth, profileReady, requireOrigin, (req, res) => {
    const parsed = joinRoomSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: '房间密码必须是 6 位数字' });
      return;
    }
    try {
      const room = roomService.joinRoom(
        currentUser(res),
        String(req.params.id ?? ''),
        parsed.data.password,
      );
      res.json({ room });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  app.post('/api/rooms/:id/leave', auth, requireOrigin, (req, res) => {
    try {
      roomService.leaveRoom(currentUser(res), String(req.params.id ?? ''));
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  app.post('/api/rooms/:id/ready', auth, profileReady, requireOrigin, (req, res) => {
    const parsed = roomReadySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'ready 必须是布尔值' });
      return;
    }
    try {
      const room = roomService.setReady(currentUser(res), String(req.params.id ?? ''), parsed.data.ready);
      res.json({ room });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  app.post('/api/rooms/:id/kick', auth, profileReady, requireOrigin, (req, res) => {
    const target = typeof req.body?.userId === 'string' ? req.body.userId : '';
    if (!target) {
      res.status(400).json({ error: 'userId is required' });
      return;
    }
    try {
      roomService.kick(currentUser(res), String(req.params.id ?? ''), target);
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  app.post('/api/rooms/:id/restart', auth, profileReady, requireOrigin, (req, res) => {
    try {
      const room = roomService.restart(currentUser(res), String(req.params.id ?? ''));
      res.json({ room });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  app.post('/api/rooms/:id/start', auth, profileReady, requireOrigin, (req, res) => {
    try {
      roomService.startRoom(currentUser(res), String(req.params.id ?? ''));
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  app.get('/api/stats/me', auth, (req, res) => {
    res.json(statsForUser(currentUser(res).id));
  });

  app.get('/api/admin/users', auth, adminGate, (req, res) => {
    const search = typeof req.query.search === 'string' ? req.query.search : '';
    const users = listUsers(db, search).map((user) => {
      const stats = statsForUser(user.id);
      return {
        ...publicUser(user),
        disabled: !!user.disabled,
        banReason: user.ban_reason,
        createdAt: user.created_at,
        wins: stats.wins,
        winsByGame: stats.winsByGame,
      };
    });
    res.json({ users });
  });

  app.post('/api/admin/users/:id/ban', auth, adminGate, requireOrigin, (req, res) => {
    const parsed = adminBanSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: '封禁参数不正确' });
      return;
    }
    const admin = currentUser(res);
    const targetId = String(req.params.id ?? '');
    if (targetId === admin.id) {
      res.status(400).json({ error: '不能封禁自己' });
      return;
    }
    const target = getUserById(db, targetId);
    if (!target) {
      res.status(404).json({ error: '用户不存在' });
      return;
    }
    updateUser(db, targetId, {
      disabled: parsed.data.disabled ? 1 : 0,
      ban_reason: parsed.data.disabled ? parsed.data.reason || '管理员封禁' : null,
    });
    if (parsed.data.disabled) {
      deleteSessionsForUser(db, targetId);
      io.in(userChannel(targetId)).disconnectSockets(true);
      roomService.removeUserFromRooms(targetId);
    }
    res.json({ ok: true });
  });

  app.post('/api/admin/users/:id/force-rename', auth, adminGate, requireOrigin, (req, res) => {
    const targetId = String(req.params.id ?? '');
    const target = getUserById(db, targetId);
    if (!target) {
      res.status(404).json({ error: '用户不存在' });
      return;
    }
    updateUser(db, targetId, { name_change_required: 1 });
    io.to(userChannel(targetId)).emit('user.updated', { nameChangeRequired: true });
    res.json({ ok: true });
  });

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  app.use('/rules', (_req, res, next) => {
    // The rules modal embeds these same-origin pages in an iframe.
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    next();
  });

  app.use(express.static(config.webDir, { extensions: ['html'] }));
  app.get('*', (_req, res) => {
    res.sendFile('index.html', { root: config.webDir }, (error) => {
      if (error) res.status(404).end();
    });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[platform] unhandled request error', error);
    if (!res.headersSent) res.status(500).json({ error: 'internal error' });
  });

  io.use((socket, next) => {
    const user = userFromCookieHeader(db, socket.handshake.headers.cookie);
    if (!user) {
      next(new Error('unauthorized'));
      return;
    }
    if (user.nameChangeRequired) {
      next(new Error('name change required'));
      return;
    }
    socket.data.user = user;
    next();
  });

  io.on('connection', (socket) => {
    void socket.join(userChannel(socket.data.user.id));

    socket.on('room.subscribe', (payload, ack) => {
      const result = roomService.subscribe(socket, payload?.roomId ?? '', !!payload?.spectate);
      ack?.(result);
    });

    socket.on('room.unsubscribe', () => {
      roomService.unsubscribe(socket);
    });

    socket.on('chat.send', (payload, ack) => {
      const text = typeof payload?.text === 'string' ? payload.text : '';
      const parsed = chatTextSchema.safeParse(text);
      if (!parsed.success) {
        ack?.({ ok: false, error: 'message must be 1-300 characters' });
        return;
      }
      ack?.(roomService.sendChat(socket, parsed.data));
    });

    socket.on('game.ready', (payload) => {
      if (typeof payload?.matchId === 'string') roomService.ready(socket, payload.matchId);
    });

    socket.on('game.action', (payload, ack) => {
      const parsed = gameActionEnvelopeSchema.safeParse(payload);
      if (!parsed.success) {
        ack?.({ ok: false, error: 'invalid action' });
        return;
      }
      ack?.(roomService.action(socket, parsed.data));
    });

    socket.on('disconnect', () => {
      roomService.unsubscribe(socket);
    });
  });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/internal/game/worker') {
      workerHub.handleUpgrade(req, socket, head);
    }
  });

  const listen = (port = config.port, host = config.host): Promise<number> =>
    new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(port, host, () => {
        httpServer.off('error', reject);
        const address = httpServer.address();
        const actualPort = typeof address === 'object' && address ? address.port : port;
        workers.setBaseUrl(`ws://127.0.0.1:${actualPort}/internal/game/worker`);
        resolve(actualPort);
      });
    });

  const close = async (): Promise<void> => {
    workerHub.close();
    workers.shutdown();
    await new Promise<void>((resolve) => io.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    db.close();
  };

  return {
    app,
    httpServer,
    io,
    db,
    catalog,
    workers,
    workerHub,
    rooms: roomService,
    listen,
    close,
  };
}

export { allowedOrigin };
export type { AuthedUser };
