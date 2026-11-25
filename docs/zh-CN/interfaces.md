# 游戏与前端接口规范

本文是 platform、game worker 和浏览器游戏模块之间的契约。

## 1. 架构

```text
浏览器
  │ HTTPS / Socket.IO
反向代理（Caddy）
  │
platform（Node/TypeScript + SQLite）
  │ WebSocket JSON 协议 v1
  └─ 每个房间/对局一个 game worker 子进程
```

platform 负责账号、房间、聊天、准备、统计和路由；game worker 负责规则和状态。
game worker 不允许发送未经裁剪的全局状态。

## 2. HTTP API

除注册/登录外都需要会话 cookie；有副作用的 POST/PATCH 还校验 Origin。

### 账号

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/register` | `{email,password,name}` → 待验证 |
| POST | `/api/auth/verify-email` | `{email,code}` → `{user}` + cookie |
| POST | `/api/auth/resend-verification` | `{email}` |
| POST | `/api/auth/login` | `{email,password}` → `{user}` + cookie |
| POST | `/api/auth/logout` | 清除会话 |
| GET | `/api/me` | 当前用户 |
| PATCH | `/api/me/name` | `{name}`，可见 ASCII 且唯一 |
| PATCH | `/api/me/avatar` | `{dataUrl}`，PNG/JPEG/WebP |
| POST | `/api/me/email/change` | `{email,password}`，需再次验证 |
| POST | `/api/me/email/verify` | `{email,code}` |

用户有 UUID `id`、大小写不敏感唯一的用户名/邮箱、可选头像，以及
`isAdmin`、`nameChangeRequired` 等状态。用户名 1–32 个可见 ASCII 字符；
密码存 scrypt；会话使用 HttpOnly cookie。

### 大厅与房间

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/games` | 游戏目录 |
| GET | `/api/rooms` | 开放房间摘要 |
| POST | `/api/rooms` | `{gameId,name?,password?}` |
| GET | `/api/rooms/:id` | 房间视图；`?spectate=1` 观战 |
| POST | `/api/rooms/:id/join` | `{password?}` |
| POST | `/api/rooms/:id/leave` | 离开；进行中会中止本局 |
| POST | `/api/rooms/:id/ready` | `{ready:boolean}` |
| POST | `/api/rooms/:id/settings` | `{settings}`；仅房主、开始前可改；通用游戏设置 |
| POST | `/api/rooms/:id/kick` | 仅房主、仅开始前 |
| POST | `/api/rooms/:id/start` | 仅房主，且全员准备 |
| POST | `/api/rooms/:id/restart` | 仅房主，结束后重开 |
| GET | `/api/rooms/:id/messages` | 最近公开聊天 |
| GET | `/api/stats/me` | 每款游戏胜场 |

房间密码为可选 6 位数字，SQLite 中存 scrypt 哈希。等待中的房间超过
`ROOM_WAIT_TIMEOUT_MS`（默认 15 分钟）仍未开始会被关闭，客户端收到带原因的
`room.kicked`。准备状态、房密码和开始前的房间设置属于 platform。
黑白棋用 `{hostColor:'black'|'white'}` 保存房主执子，开始时连同
`hostUserId` 一起传给 worker。

### 管理

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/users?search=` | 用户列表（含胜场） |
| POST | `/api/admin/users/:id/ban` | `{disabled,reason?}` |
| POST | `/api/admin/users/:id/force-rename` | 强制更换用户名 |

封禁会清除会话和 socket；不删除历史对局。

## 3. Socket.IO（浏览器 ↔ platform）

客户端事件：

```ts
room.subscribe({ roomId, spectate? }, ack)
room.unsubscribe()
chat.send({ text }, ack)
game.ready({ matchId })
game.action({ matchId, seq, actionId, action }, ack)
```

服务端事件：

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

`seq` 是当前 match 的平台序号；旧序号动作会被拒绝。`actionId` 是幂等键。

## 4. Worker 协议 v1

platform 为每个 match 启动 worker，传入 `MATCH_ID`、`ROOM_ID`、`GAME_ID`、
`PLATFORM_WS_URL`、`GAME_SECRET`、`SEATS_JSON`、`SETTINGS_JSON` 等环境变量。
worker 连到 `PLATFORM_WS_URL`，交换 JSON。

### platform → game

```ts
{ v:1, t:'register.ack', ok:true, gameId }
{ v:1, t:'register.ack', ok:false, error }
{ v:1, t:'match.create', matchId, gameId, seats, settings }
{ v:1, t:'player.ready', matchId, playerId }
{ v:1, t:'action', matchId, playerId, seq, actionId, action }
{ v:1, t:'player.connection', matchId, playerId, connected }
{ v:1, t:'match.abort', matchId, reason }
```

### game → platform

```ts
{ v:1, t:'register', game, secret, matchId? }
{ v:1, t:'view', matchId, to, seq, view, actions? }
{ v:1, t:'event', matchId, to:'room'|`player:<id>`, event }
{ v:1, t:'match.started', matchId }
{ v:1, t:'result', matchId, result }
{ v:1, t:'error', matchId?, playerId?, code, message }
```

`view.to` 必须存在，且为 `"player:<userId>"` 或 `"spectator"`。platform 只
路由并按目标保留最新视图，不保存完整对局状态。

### 隐私规则

- 不发送全局状态广播。
- 每个玩家的 view 必须只包含该玩家可见的信息。
- 观战 view 可以展示全部信息，但由 game 决定。
- `result.winners` 是 userId 字符串数组；空数组为平局。
- 每个 match 的 `seq` 单调递增。
- worker 重启后内存状态丢失；platform 会把该局标记为 aborted/waiting。

## 5. 浏览器游戏模块

platform 壳动态导入 `/games/<gameId>.js`（由游戏子模块生成），调用：

```js
export function render(container, { view, actions, myUserId, onAction }) {
  // 根据服务端 view 渲染整个游戏区
}
```

约束：

- 只用 `view`、`actions`、`myUserId`、`onAction` 和 `container`。
- 根据服务端 view 渲染，不自行实现游戏规则。
- `view.you === null` 表示观战者。
- 不创建本地聊天框；聊天归 platform。
- 用 `textContent`/`createElement`，不要把用户数据拼 HTML。
- `render` 会被反复调用，必须幂等。
- 不要假设其他玩家的隐藏状态存在。

## 6. 游戏子模块结构

每个游戏是独立仓库，由主仓库固定提交：

```text
src/games/<name>/
  *.ts                 规则、worker、metadata
  web/                 浏览器模块
  web/cards/           可选卡图
  README.md
```

游戏通过 `../../protocol/protocol.js` 使用主仓库共享协议；它在主仓库工作区
内构建和测试，不是独立 npm 包。主仓库在 `src/platform/game-catalog.ts`
注册 worker 和 metadata。

一个实现可以暴露多个 catalog ID：例如 `ice` 仓库同时提供 `ice`（标准）
和 `ice-chaos`（混沌），两者指向同一个 worker。`reversi` 与 `alendo` 是双人完全信息游戏，房主执子属于房间设置，观战聊天开启。
`alendo` 使用 Hypergryph《来自星尘》的 96 格三角棋盘，并强制显示合法落点提示。
`gomoku` / `gomoku-seki` 共用一个引擎：11×11 无禁手（平局白胜）和 15×15
彗星座子（黑 H8、白 J7、黑 F10，白先；平局双方均败）。`gomoku-forbidden`
增加指定开局和黑棋禁手（长连/双四/双三），并只给黑棋提供可开关的禁手提示；
`gomoku-rif` 再增加三手交换和五手两打。无禁手/座子不提供提示；坐标跳过 I
（A-H、J-P）。

### 版本管理

主仓库记录每个子模块的 commit。升级游戏：

```bash
cd src/games/ice
git fetch && git checkout <commit-or-tag>
cd ../../..
git add src/games/ice
git commit -m "feat: bump ice game"
```

生产环境建议使用游戏仓库的 tag。platform 协议版本与游戏版本相互独立。

## 7. 测试边界

- 游戏引擎单元测试在主仓库 `tests/`。
- 平台/游戏集成测试使用内存 SQLite + 真实 worker 进程。
- 浏览器模块是普通 ES Module，通过手工或浏览器测试运行器验证；不得依赖 Node API。
  黑白棋的“提示”是本地 UI 状态，开关只影响自己的显示，不会改变对手视图。

> 频率限制按邮箱/账号而不是按来源 IP 计算。校园网 NAT 下所有玩家通常共享同一个公网 IP，按 IP 限制会误伤整批玩家。
