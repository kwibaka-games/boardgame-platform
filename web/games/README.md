# Generated game UI

This directory is generated from the game submodules by:

```bash
npm run sync-games
```

Do not edit `web/games/*.js` or `web/games/ice/` directly. The source of truth
is each submodule's `web/` directory:

```text
src/games/ice/web/ice.js
src/games/ice/web/ice-chaos.js
src/games/ice/web/cards/
src/games/mock/web/mock-ttt.js
```

The platform shell dynamically imports `/games/<gameId>.js`. A module exports:

```js
export function render(container, { view, actions, myUserId, onAction }) {
  // Render the game area from the server-provided view.
}
```

See [English interface guide](../../docs/en/interfaces.md) or
[中文接口规范](../../docs/zh-CN/interfaces.md).
