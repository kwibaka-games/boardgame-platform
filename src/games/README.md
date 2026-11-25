# Game submodules

Each directory here is a git submodule:

```text
src/games/ice   -> github.com/ZangXuanyi/kwibaka-game-ice
src/games/mock  -> github.com/ZangXuanyi/kwibaka-game-mock-ttt
```

A game repository contains its rules, worker, metadata, browser module, and
optional card art. The host protocol is shared from
`src/protocol/protocol.ts`; inside a game, use a relative import such as
`../../protocol/protocol.js`.

Host responsibilities:

- spawn one worker per match and pass `MATCH_ID`, `GAME_ID`, `SEATS_JSON`,
  `PLATFORM_WS_URL`, `GAME_SECRET`, and `SETTINGS_JSON`;
- route targeted `view` messages without storing full state;
- register the worker in `src/platform/game-catalog.ts`.

Game responsibilities:

- send `view` only with an explicit `to` target;
- trim hidden state per target and per spectator;
- emit monotonic `seq` and a terminal `result` with `winners: string[]`;
- keep browser modules under `web/` (plain ES modules, no Node APIs).

See [English interface guide](../../docs/en/interfaces.md) or
[中文接口规范](../../docs/zh-CN/interfaces.md). To update a pinned game:

```bash
cd src/games/ice
git fetch && git checkout <tag-or-commit>
cd ../../..
git add src/games/ice
git commit -m "chore: update ice game"
```
