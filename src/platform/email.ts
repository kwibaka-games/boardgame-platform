import { randomInt } from 'node:crypto';
import nodemailer from 'nodemailer';
import type { Config } from './config.js';

export interface Mailer {
  sendVerification(to: string, code: string, purpose: 'register' | 'change'): Promise<void>;
}

export function createMailer(config: Config): Mailer {
  const smtpConfigured = !!config.smtpHost;
  const transport = smtpConfigured
    ? nodemailer.createTransport({
        host: config.smtpHost!,
        port: config.smtpPort,
        secure: config.smtpSecure,
        auth:
          config.smtpUser && config.smtpPass
            ? { user: config.smtpUser, pass: config.smtpPass }
            : undefined,
      })
    : null;

  return {
    async sendVerification(to, code, purpose) {
      const subject =
        purpose === 'register' ? '验证你的桌游室邮箱' : '确认新的桌游室邮箱';
      const action = purpose === 'register' ? '注册' : '换绑邮箱';
      const text = `你的${action}验证码是：${code}\n\n验证码 15 分钟内有效。如果这不是你本人的操作，请忽略这封邮件。`;
      if (!transport) {
        if (config.emailDebug) {
          console.log(`[email:debug] ${to} ${purpose} code=${code}`);
          return;
        }
        throw new Error('邮件服务未配置，请联系管理员设置 SMTP');
      }
      await transport.sendMail({
        from: config.mailFrom || config.smtpUser || 'no-reply@localhost',
        to,
        subject,
        text,
      });
    },
  };
}

export function generateEmailCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}
