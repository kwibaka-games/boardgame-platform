import path from 'node:path';

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function envBool(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

export interface Config {
  port: number;
  host: string;
  dbPath: string;
  webDir: string;
  publicOrigin: string | null;
  /** Additional exact origins accepted for CORS/CSRF, e.g. domain:8443. */
  publicOrigins?: string[];
  cookieSecure: boolean;
  sessionTtlMs: number;
  gameSecret: string;
  loginRateLimit: number;
  adminEmail: string | null;
  emailDebug: boolean;
  smtpHost: string | null;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string | null;
  smtpPass: string | null;
  mailFrom: string | null;
}

export function loadConfig(): Config {
  const publicOrigins = (process.env.PUBLIC_ORIGINS || process.env.PUBLIC_ORIGIN || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  return {
    port: envInt('PORT', 8080),
    host: process.env.HOST || '0.0.0.0',
    dbPath: process.env.DB_PATH || path.resolve(process.cwd(), 'data', 'platform.db'),
    webDir: process.env.WEB_DIR || path.resolve(process.cwd(), 'web'),
    publicOrigin: publicOrigins[0] || null,
    publicOrigins,
    cookieSecure: envBool('COOKIE_SECURE', false),
    sessionTtlMs: envInt('SESSION_TTL_HOURS', 24 * 7) * 60 * 60 * 1000,
    gameSecret: process.env.GAME_SECRET || 'dev-game-secret-change-me',
    loginRateLimit: envInt('LOGIN_RATE_LIMIT', 20),
    adminEmail: process.env.ADMIN_EMAIL ? process.env.ADMIN_EMAIL.trim().toLowerCase() : null,
    emailDebug: envBool('EMAIL_DEBUG', false),
    smtpHost: process.env.SMTP_HOST || null,
    smtpPort: envInt('SMTP_PORT', 587),
    smtpSecure: envBool('SMTP_SECURE', false),
    smtpUser: process.env.SMTP_USER || null,
    smtpPass: process.env.SMTP_PASS || null,
    mailFrom: process.env.MAIL_FROM || null,
  };
}
