# 测试

## 1. 准备

```bash
git submodule update --init --recursive
npm ci
npm run sync-games
```

`sync-games` 从游戏子模块复制浏览器模块和卡图到被 gitignore 的
`web/games/`。`npm run build` 和 `npm run dev:platform` 也会自动运行它。

## 2. 自动测试

```bash
npm test
```

覆盖：

- 注册、邮箱验证、登录、个人资料、换绑邮箱、头像校验、管理员封禁/强制改名；
- 房间密码、准备、开始门槛、踢人、重新开始；
- mock 井字棋平台流程、隐私、观战聊天、崩溃隔离；
- 《冰冷的她醒来之前》牌堆/结算/规则、私有视图、同时选择、重连和平台集成；
- 黑白棋合法落子/翻子、房主执子分配、完整对局终局、认输，以及真实
  platform/worker 集成测试；
- 阿尔林铎棋 96 格三角棋盘/条带、六枚座子、房主执子、随机完整对局终局、认输。

测试使用内存 SQLite 和真实 worker 子进程，不需要外部服务。

## 3. 类型与构建

```bash
npm run build
```

先运行 `tsc`，再从游戏子模块生成浏览器资源。Docker 构建会重复这两步。

## 4. 冰她随机 fuzz

```bash
npm run fuzz:ice -- 1000
```

用完全随机合法动作驱动真实的 `IceMatch` 状态机，检查卡牌守恒、视图隐私、
seq 完整性、结果结构和终局。它不放进 `npm test`，因为它是压力测试，可跑更多局。

## 5. 游戏专属测试

在主仓库 `tests/` 添加纯引擎测试，直接导入游戏子模块：

```ts
import { IceMatch } from '../src/games/ice/game.js';
```

新游戏建议至少包含：

- 牌堆/卡效/规则边界单元测试；
- 一局完整随机或确定性对局；
- 新协议行为的平台集成测试；
- 新 UI 的浏览器冒烟测试。

## 6. 手工验收清单

1. 用新邮箱注册，确认验证码送达（本地可 `EMAIL_DEBUG=1`）。
2. 第一个验证账号出现管理入口；修改用户名和头像。
3. 创建带密码房间；用错误/正确密码加入。
4. 准备/取消准备；未全员准备时房主不能开始。
5. 开始前踢人；被踢玩家回到大厅。
6. 开始一局；确认每个玩家只看到自己的视图，观战者看到预期全量信息。
7. 对局结束；确认结果、统计、“重新开始”回到等待。
8. 强制另一账号改名；确认改名后才能继续。
9. 封禁/解封；封禁后旧会话失效。
10. 使用全新浏览器重新加载，确认登录/会话行为。

## 7. CI 建议

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

不要把 SMTP 凭据或 `deploy/.env` 放进 CI 日志。
