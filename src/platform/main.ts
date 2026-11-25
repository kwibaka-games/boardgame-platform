import os from 'node:os';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createPlatform } from './server.js';

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) out.push(entry.address);
    }
  }
  return out;
}

const config = loadConfig();
const db = openDb(config.dbPath);

const platform = createPlatform(config, db);
const port = await platform.listen();
console.log(`[platform] listening on ${config.host}:${port}`);
console.log(`[platform] local: http://127.0.0.1:${port}`);
for (const address of lanAddresses()) {
  console.log(`[platform] LAN:   http://${address}:${port}`);
}
console.log(`[platform] game worker ws: ws://127.0.0.1:${port}/internal/game/worker`);

let closing = false;
const shutdown = async (signal: string): Promise<void> => {
  if (closing) return;
  closing = true;
  console.log(`[platform] ${signal} received, shutting down`);
  await platform.close().catch((error) => console.warn('[platform] close error', error));
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
