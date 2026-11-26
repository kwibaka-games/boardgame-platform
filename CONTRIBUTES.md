# Contributing

Thanks for helping with the platform and its games.

## Repository layout

| What | Where to contribute |
|---|---|
| Platform, web shell, protocol, deployment, docs | [`kwibaka-games/boardgame-platform`](https://github.com/kwibaka-games/boardgame-platform) |
| Gomoku | [`kwibaka-games/gomoku`](https://github.com/kwibaka-games/gomoku) |
| Reversi | [`kwibaka-games/reversi`](https://github.com/kwibaka-games/reversi) |
| Alendo / 阿尔林铎棋 | [`kwibaka-games/alendo`](https://github.com/kwibaka-games/alendo) |
| Before She Rises / 冰她 | [`kwibaka-games/before-she-rises`](https://github.com/kwibaka-games/before-she-rises) |
| Mock tic-tac-toe reference game | [`kwibaka-games/mock-ttt`](https://github.com/kwibaka-games/mock-ttt) |
| Amazons / 亚马逊棋 | [`kwibaka-games/amazons`](https://github.com/kwibaka-games/amazons) |
| Einstein chess / 爱因斯坦棋 | [`kwibaka-games/einstein`](https://github.com/kwibaka-games/einstein) |
| Red Gate / 红色的门和杀人鬼的钥匙 | [`kwibaka-games/red-gate`](https://github.com/kwibaka-games/red-gate) |

## Platform changes

Open a pull request against `kwibaka-games/boardgame-platform` (`main`).
Platform PRs must include tests for behavior changes and keep `npm test` and
`npm run build` green.

## Changes to an existing game

Open a pull request against that game's repository, not against the platform.
Game repositories contain their rules, worker, browser module, and game tests.
The platform only pins a game submodule commit.

After a game PR is merged, update the platform pin in a separate platform PR:

```bash
cd src/games/<game>
git fetch && git checkout <merged-commit>
cd ../../..
git add src/games/<game>
git commit -m "chore: update <game> submodule"
```

Do not edit generated `web/games/` files; run `npm run sync-games` instead.

## Adding a new game

1. Create the game in its own public git repository, outside the platform tree.
2. Implement the worker protocol and browser module using the host contract:
   `src/protocol/protocol.ts` and `docs/en/interfaces.md`.
3. Add it as a submodule:

   ```bash
   git submodule add ../<new-game>.git src/games/<new-game>
   # or with an absolute URL:
   git submodule add https://github.com/<owner>/<new-game>.git src/games/<new-game>
   ```

4. Register its worker and metadata in `src/platform/game-catalog.ts`.
5. Add engine and integration tests under `tests/`, run `npm run sync-games`,
   `npm test`, and `npm run build`.
6. Open a platform PR containing the submodule pointer, catalog entry, UI sync
   setup (if needed), tests, and documentation.

Submodules must be public so GitHub Actions can check out pull requests.
Never commit `.env`, SMTP credentials, certificates, databases, or logs.

## CI

Every pull request runs the `verify` job: recursive submodule checkout,
dependency install, submodule validation, `npm run sync-games`, `npm test`, and
`npm run build`. The branch is protected so the PR cannot be merged unless the
`verify` check succeeds.

## License

Contributions are accepted under AGPL-3.0-only.
