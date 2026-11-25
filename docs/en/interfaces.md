# Game and Frontend Interfaces

This document is the contract between the platform, a game worker, and a
browser game module. It is intentionally language-agnostic for game workers.

## 1. Architecture

```text
browser
  |  HTTPS / Socket.IO
reverse proxy (Caddy)
  |
platform (Node/TypeScript, SQLite)
  |  WebSocket JSON protocol v1
  +-- game worker process (one per room/match)
```

The platform owns accounts, rooms, chat, readiness, waiting-room expiry, stats,
and routing. A game
worker owns its rules and state. A game worker never sends an unfiltered global
state to the platform.

## 2. HTTP API

All API routes except registration/login require the session cookie. Stateful
POST/PATCH routes also validate `Origin`.

### Accounts

| Method | Path | Body / result |
|---|---|---|
| POST | `/api/auth/register` | `{email,password,name}` → `{pending:true,email}` |
| POST | `/api/auth/verify-email` | `{email,code}` → `{user}` + cookie |
| POST | `/api/auth/resend-verification` | `{email}` |
| POST | `/api/auth/login` | `{email,password}` → `{user}` + cookie |
| POST | `/api/auth/logout` | clears session |
| GET | `/api/me` | current public user |
| PATCH | `/api/me/name` | `{name}` |
| PATCH | `/api/me/avatar` | `{dataUrl}` (PNG/JPEG/WebP data URL) |
| POST | `/api/me/email/change` | `{email,password}` → verification required |
| POST | `/api/me/email/verify` | `{email,code}` |

Users have a UUID `id`, unique case-insensitive name and email, optional avatar,
and `isAdmin`, `nameChangeRequired` flags. Usernames are 1–32 printable ASCII
characters. Password hashes are scrypt; sessions are HttpOnly cookies.

### Lobby and rooms

| Method | Path | Description |
|---|---|---|
| GET | `/api/games` | catalog metadata |
| GET | `/api/rooms` | open room summaries |
| POST | `/api/rooms` | `{gameId,name?,password?}` |
| GET | `/api/rooms/:id` | room view (`?spectate=1` for spectators) |
| POST | `/api/rooms/:id/join` | `{password?}` |
| POST | `/api/rooms/:id/leave` | leave; abort active match |
| POST | `/api/rooms/:id/ready` | `{ready:boolean}` |
| POST | `/api/rooms/:id/settings` | `{settings}`; owner only, waiting only; generic game settings |
| POST | `/api/rooms/:id/kick` | owner only, waiting only |
| POST | `/api/rooms/:id/start` | owner only; all players ready |
| POST | `/api/rooms/:id/restart` | owner only; after finished |
| GET | `/api/rooms/:id/messages` | recent public chat |
| GET | `/api/stats/me` | wins per game |

Room passwords are optional six-digit numeric strings, stored as scrypt hashes.
A waiting room that has not started within `ROOM_WAIT_TIMEOUT_MS` (default 15
minutes) is closed; clients receive `room.kicked` with a timeout reason.
Ready state, passwords, and pre-start room settings belong to the platform.
Reversi stores `{hostColor:'black'|'white'}` and passes `hostUserId` with the
settings to the worker at start.

### Administration

| Method | Path | Description |
|---|---|---|
| GET | `/api/admin/users?search=` | user list with wins |
| POST | `/api/admin/users/:id/ban` | `{disabled,reason?}` |
| POST | `/api/admin/users/:id/force-rename` | require a new username |

Banning removes sessions and sockets; it does not delete match history.

## 3. Socket.IO (browser ↔ platform)

Client events:

```ts
room.subscribe({ roomId, spectate? }, ack)
room.unsubscribe()
chat.send({ text }, ack)
game.ready({ matchId })
game.action({ matchId, seq, actionId, action }, ack)
```

Server events:

```ts
room.state(RoomView)
room.players(PlayerView[])
room.spectators({userId,name}[])
room.kicked({roomId,reason?})
user.updated({nameChangeRequired?})
chat.message(ChatMessage)
game.view({matchId,seq,view,actions?})
game.started({matchId})
game.result({matchId,result})
game.event({matchId,event})
error({code,message})
```

`seq` is the current platform sequence for a match. Actions with an old `seq`
are rejected. `actionId` is an idempotency key.

## 4. Worker protocol v1

The platform starts a worker per match with environment variables including
`MATCH_ID`, `ROOM_ID`, `GAME_ID`, `PLATFORM_WS_URL`, `GAME_SECRET`,
`SEATS_JSON`, and `SETTINGS_JSON`. The worker connects to
`PLATFORM_WS_URL` and exchanges JSON messages.

### Platform → game

```ts
{ v:1, t:'register.ack', ok:true, gameId }
{ v:1, t:'register.ack', ok:false, error }
{ v:1, t:'match.create', matchId, gameId, seats, settings }
{ v:1, t:'player.ready', matchId, playerId }
{ v:1, t:'action', matchId, playerId, seq, actionId, action }
{ v:1, t:'player.connection', matchId, playerId, connected }
{ v:1, t:'match.abort', matchId, reason }
```

### Game → platform

```ts
{ v:1, t:'register', game, secret, matchId? }
{ v:1, t:'view', matchId, to, seq, view, actions? }
{ v:1, t:'event', matchId, to:'room'|`player:<id>`, event }
{ v:1, t:'match.started', matchId }
{ v:1, t:'result', matchId, result }
{ v:1, t:'error', matchId?, playerId?, code, message }
```

`view.to` is mandatory and must be `"player:<userId>"` or `"spectator"`.
The platform routes it and stores only the latest view per target.

### Privacy rules

- Never broadcast a global state message.
- Trim each player's view to what that player may see.
- Spectator views may reveal everything, but the game decides what that means.
- `result.winners` is an array of userId strings; `[]` means a draw.
- Send `seq` monotonically per match.
- A worker restart loses in-memory state; the platform marks the match aborted.

## 5. Browser game module

The shell dynamically imports `/games/<gameId>.js` (generated from the game
submodule) and calls:

```js
export function render(container, { view, actions, myUserId, onAction }) {
  // Render the whole game area from the server-provided view.
}
```

Rules:

- Use only `view`, `actions`, `myUserId`, `onAction`, and `container`.
- Render from the server view; do not independently implement game rules.
- `view.you === null` means spectator.
- Do not create a local chat UI; the shell owns chat.
- Use `textContent`/`createElement`, not HTML strings containing user data.
- `render` is called repeatedly and must be idempotent.
- Never assume hidden state for other players exists in the view.

## 6. Game submodule layout

Each game is a separate repository, pinned by the main repo:

```text
src/games/<name>/
  *.ts                 worker/rules/metadata
  web/                 browser module(s)
  web/cards/           optional card art
  README.md
```

The game imports the shared host protocol at
`../../protocol/protocol.js`. It is built and tested inside the host workspace;
it is not a standalone npm package. The host registers its worker and metadata
in `src/platform/game-catalog.ts`.

A single implementation may expose multiple catalog IDs. Example: the `ice`
repository provides `ice` (standard) and `ice-chaos` (chaos), both pointing at
the same worker. `reversi` is a two-player complete-information game; the host
color is a room setting, and `spectatorChat` is enabled.

### Versioning

The main repository pins each submodule commit. To update a game:

```bash
cd src/games/ice
git fetch && git checkout <commit-or-tag>
cd ../../..
git add src/games/ice
git commit -m "feat: bump ice game"
```

Use tagged game releases for production upgrades. The platform protocol version
is independent from game versions.

## 7. Testing surface

- Game engine unit tests live in the host `tests/` directory.
- Platform/game integration tests use an in-memory platform and real worker
  processes.
- Browser modules are plain ES modules and are exercised manually or by a
  browser test runner; they must not depend on Node APIs. Reversi's move hints
  are local UI state, so toggling them never changes the opponent's view.

> Rate limits are scoped per email/account, not per source IP. Campus NAT commonly makes every player share one public IP, so IP-based limits would block the whole group.
