# Testing

## 1. Prerequisites

```bash
git submodule update --init --recursive
npm ci
npm run sync-games
```

`sync-games` copies browser modules and card art from the game submodules into
the gitignored `web/games/` tree. `npm run build` and `npm run dev:platform`
also run it automatically.

## 2. Automated suite

```bash
npm test
```

The suite covers:

- account registration, email verification, login, profiles, email change,
  avatar validation, admin ban and force-rename;
- room passwords, readiness, start gating, kick and restart;
- the mock tic-tac-toe platform flow, privacy, spectator chat and crash
  isolation;
- 《冰冷的她醒来之前》 deck/settlement/rules, private views, simultaneous
  choices, reconnect and platform integration.
- Reversi legal moves/flips, host color assignment, full-game termination,
  resignation, and a real platform/worker integration test.
- Alendo 96-triangle geometry/strips, six-piece setup, host color, random
  full-game termination, and resignation.
- Gomoku 11×11/15×15 setup, win detection (including overlines), white
  first in seki, draw outcomes, and resignation.

`npm test` uses an in-memory SQLite database and starts real worker child
processes; no external services are needed.

## 3. Type/build checks

```bash
npm run build
```

This runs `tsc`, then generates the browser assets from the game submodules.
The Docker build repeats both steps.

## 4. Fuzz testing the ice engine

```bash
npm run fuzz:ice -- 1000
```

The fuzzer drives the real `IceMatch` state machine with a random legal-action
policy. It checks card conservation, view privacy, sequence integrity, result
shape, and termination. It is intentionally not part of `npm test` because it is
a stress test and can be run with a larger game count.

## 5. Game-specific tests

Add pure engine tests under `tests/` in the host repository, importing the game
submodule:

```ts
import { IceMatch } from '../src/games/ice/game.js';
```

For a new game, add:

- unit tests for deck/card/rule edge cases;
- a full random or deterministic match test;
- a platform integration test if the game has new protocol behavior;
- a browser smoke test if it has new UI.

## 6. Manual acceptance checklist

1. Register a fresh email; confirm the code arrives (or use `EMAIL_DEBUG=1`
   locally).
2. First verified account shows the admin entry; change username and avatar.
3. Create a password-protected room; join with a wrong and correct password.
4. Ready/unready; confirm the host cannot start until every player is ready.
5. Kick a player before start; confirm they return to the lobby.
6. Start a game; confirm each player sees only their own view and spectators see
   the intended full view.
7. Finish a game; confirm result, stats, and “restart” go back to waiting.
8. Force-rename a second account; confirm it must choose a new name before
   joining or continuing.
9. Ban/unban; confirm sessions are invalidated on ban.
10. Reload with a fresh browser and confirm login/session behavior.

## 7. CI suggestions

A minimal GitHub Actions job:

```yaml
- uses: actions/checkout@v4
  with:
    submodules: recursive
- uses: actions/setup-node@v4
  with:
    node-version: 24
- run: npm ci
- run: npm run sync-games
- run: npm test
- run: npm run build
```

Do not put SMTP credentials or `deploy/.env` in CI logs.
