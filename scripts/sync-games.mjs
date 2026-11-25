#!/usr/bin/env node
/**
 * Copy game-owned browser assets from game submodules into web/games.
 *
 * Game repositories are the source of truth for both their worker and their
 * browser module. The main platform only contains the shell and the generated
 * web/games directory; generated files are gitignored.
 */
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const gamesDir = path.join(root, 'src', 'games');
const outputDir = path.join(root, 'web', 'games');

async function directories(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  const gameNames = await directories(gamesDir);
  let copied = 0;
  for (const game of gameNames) {
    const webDir = path.join(gamesDir, game, 'web');
    try {
      await stat(webDir);
    } catch {
      continue;
    }
    const entries = await readdir(webDir, { withFileTypes: true });
    for (const entry of entries) {
      const source = path.join(webDir, entry.name);
      if (entry.isDirectory()) {
        const target = path.join(outputDir, game, entry.name);
        await rm(target, { recursive: true, force: true });
        await mkdir(path.dirname(target), { recursive: true });
        await cp(source, target, { recursive: true });
        copied += 1;
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        const target = path.join(outputDir, entry.name);
        await cp(source, target);
        copied += 1;
      }
    }
  }
  console.log(`[sync-games] copied ${copied} generated browser assets to web/games`);
}

main().catch((error) => {
  console.error('[sync-games] failed', error);
  process.exit(1);
});
