import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ICE_CHAOS_GAME, ICE_GAME } from '../games/ice/metadata.js';
import { MOCK_GAME } from '../games/mock/metadata.js';
import { REVERSI_GAME } from '../games/reversi/metadata.js';
import { ALENDO_GAME } from '../games/alendo/metadata.js';
import { GOMOKU_FORBIDDEN_GAME, GOMOKU_GAME, GOMOKU_RIF_GAME, GOMOKU_SEKI_GAME } from '../games/gomoku/metadata.js';
import type { GameId, GameMetadata } from '../protocol/protocol.js';

export interface GameCatalogEntry {
  metadata: GameMetadata;
  /**
   * Source file used in development (run with `node --import tsx`), and the
   * compiled file used in production / Docker.
   */
  worker: {
    src: string;
    dist: string;
    /** Optional executable for non-Node workers; env carries match/seats data. */
    command?: string;
    args?: string[];
  };
}

const root =
  process.env.APP_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const GAME_CATALOG: GameCatalogEntry[] = [
  {
    metadata: MOCK_GAME,
    worker: {
      src: path.resolve(root, 'src/games/mock/worker.ts'),
      dist: path.resolve(root, 'dist/games/mock/worker.js'),
    },
  },
  {
    metadata: GOMOKU_GAME,
    worker: {
      src: path.resolve(root, 'src/games/gomoku/worker.ts'),
      dist: path.resolve(root, 'dist/games/gomoku/worker.js'),
    },
  },
  {
    metadata: GOMOKU_SEKI_GAME,
    worker: {
      src: path.resolve(root, 'src/games/gomoku/worker.ts'),
      dist: path.resolve(root, 'dist/games/gomoku/worker.js'),
    },
  },
  {
    metadata: GOMOKU_FORBIDDEN_GAME,
    worker: {
      src: path.resolve(root, 'src/games/gomoku/worker.ts'),
      dist: path.resolve(root, 'dist/games/gomoku/worker.js'),
    },
  },
  {
    metadata: GOMOKU_RIF_GAME,
    worker: {
      src: path.resolve(root, 'src/games/gomoku/worker.ts'),
      dist: path.resolve(root, 'dist/games/gomoku/worker.js'),
    },
  },
  {
    metadata: ALENDO_GAME,
    worker: {
      src: path.resolve(root, 'src/games/alendo/worker.ts'),
      dist: path.resolve(root, 'dist/games/alendo/worker.js'),
    },
  },
  {
    metadata: REVERSI_GAME,
    worker: {
      src: path.resolve(root, 'src/games/reversi/worker.ts'),
      dist: path.resolve(root, 'dist/games/reversi/worker.js'),
    },
  },
  {
    metadata: ICE_GAME,
    worker: {
      src: path.resolve(root, 'src/games/ice/worker.ts'),
      dist: path.resolve(root, 'dist/games/ice/worker.js'),
    },
  },
  {
    metadata: ICE_CHAOS_GAME,
    worker: {
      src: path.resolve(root, 'src/games/ice/worker.ts'),
      dist: path.resolve(root, 'dist/games/ice/worker.js'),
    },
  },
];

export class GameCatalog {
  list(): GameMetadata[] {
    return GAME_CATALOG.map((entry) => entry.metadata);
  }

  get(gameId: GameId): GameMetadata | null {
    return GAME_CATALOG.find((entry) => entry.metadata.id === gameId)?.metadata ?? null;
  }

  entry(gameId: GameId): GameCatalogEntry | null {
    return GAME_CATALOG.find((entry) => entry.metadata.id === gameId) ?? null;
  }
}
