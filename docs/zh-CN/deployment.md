# 部署

本文说明如何部署这个自建桌游平台。适用于有 Docker、域名和 TLS 证书的
Linux/macOS 主机。

## 1. 依赖

- 本地开发需要 Node.js **24+**；Docker 构建使用自带 Node 镜像。
- Docker Engine + Docker Compose v2。
- 一个指向服务器的域名（或局域网地址）。
- HTTPS 需要对应域名的证书，以及 Caddy 或其它反向代理。
- 可选：用于真实邮箱验证的 SMTP 账号。

平台只暴露一个浏览器入口；每个对局的 game worker 是子进程，不对外开端口。

## 2. 克隆与游戏子模块

游戏是独立仓库，通过 git submodule 固定版本：

```bash
git clone --recurse-submodules https://github.com/ZangXuanyi/kwibaka-boardgame-platform.git
cd kwibaka-boardgame-platform

# 如果克隆时没带 submodule：
git submodule update --init --recursive

# 从游戏子模块生成浏览器资源
npm run sync-games
```

不要直接修改生成的 `web/games/*.js` 或 `web/games/ice/`。要改游戏，去对应
游戏仓库修改，然后在主仓库运行 `npm run sync-games`。

## 3. 环境变量

```bash
cp deploy/.env.example deploy/.env
chmod 600 deploy/.env
```

主要变量：

| 变量 | 作用 |
|---|---|
| `PUBLIC_ORIGIN` | 浏览器访问的规范 Origin，必须与地址栏完全一致。 |
| `PUBLIC_ORIGINS` | 可选的额外精确 Origin（IP/端口测试用）。 |
| `COOKIE_SECURE` | HTTPS 下为 `1`，纯 HTTP 本地测试为 `0`。 |
| `GAME_SECRET` | platform 与 game worker 的共享密钥，必须随机。 |
| `SESSION_TTL_HOURS` | 登录会话有效期。 |
| `ROOM_WAIT_TIMEOUT_MS` | 房间等待超时（毫秒）；从创建/重开起 15 分钟未开始则自动关闭。 |
| `ADMIN_EMAIL` | 可选，指定注册后自动成为管理员的邮箱。 |
| `EMAIL_DEBUG` | `1` 时验证码显示在页面/日志，正式站禁止使用。 |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` / `MAIL_FROM` | 真实邮件发送。 |
| `DB_PATH` | 容器内 SQLite 路径，默认 `/app/data/platform.db`。 |

`deploy/.env`、`deploy/certs/`、数据库、日志、SMTP 密码一律不要提交。
`.gitignore` 已经排除它们。

### SMTP

QQ 邮箱示例（使用邮箱设置中生成的 SMTP 授权码，不是登录密码）：

```env
SMTP_HOST=smtp.qq.com
SMTP_PORT=465
SMTP_SECURE=1
SMTP_USER=you@foxmail.com
SMTP_PASS=<QQ SMTP 授权码>
MAIL_FROM=you@foxmail.com
EMAIL_DEBUG=0
```

如果要用 `no-reply@example.com` 这种域名地址，建议使用事务邮件服务，并按
服务商要求配置 SPF、DKIM、DMARC。仅在本机搭建 SMTP 服务器通常不能解决
外网投递：校园网/家庭宽带 IP 往往缺少反向解析，25 端口也可能被封锁，邮件
容易被拒收或进垃圾箱。

## 4. 本地开发

```bash
npm install
EMAIL_DEBUG=1 PORT=8080 DB_PATH="$PWD/data/dev.db" npm run dev:platform
```

打开 `http://127.0.0.1:8080`。没有预置测试账号：自行注册邮箱、验证、登录。
第一个完成验证的账号自动成为管理员；也可以用 `ADMIN_EMAIL` 预留管理员邮箱。

常用检查：

```bash
npm test
npm run build
npm run fuzz:ice -- 1000
```

## 5. Docker Compose

```bash
cp deploy/.env.example deploy/.env
# 编辑 deploy/.env
docker compose -f deploy/docker-compose.yml --profile edge up -d --build
```

会启动：

- `platform`：内部 `8080`；
- `caddy`：发布 `80`、`443`，终止 TLS 并反向代理到 platform。

证书放在 `deploy/certs/fullchain.pem` 和 `deploy/certs/key.pem`，以只读方式
挂载；示例见 `deploy/Caddyfile`。

如果使用自己的反向代理，只启动 platform：

```bash
docker compose -f deploy/docker-compose.yml up -d --build platform
```

然后让 Nginx/Caddy 代理到 `127.0.0.1:8080`。

### 第一个管理员

第一个验证成功的注册账号自动成为管理员。也可以在注册前设置
`ADMIN_EMAIL`，或使用 CLI 创建一个已验证的引导账号：

```bash
docker compose -f deploy/docker-compose.yml exec platform \
  node dist/cli/add-user.js you@example.com YourName 'a-long-password' --admin
```

### 更新

```bash
git pull
git submodule update --init --recursive
npm run sync-games
docker compose -f deploy/docker-compose.yml --profile edge up -d --build
```

SQLite 在 `platform-data` Docker volume 中，重建镜像不会丢数据。不要让两个
platform 实例同时写同一个 SQLite 数据库。

## 6. 备份与恢复

不停机逻辑备份：

```bash
docker compose -f deploy/docker-compose.yml exec platform \
  node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/app/data/platform.db');d.exec(\"VACUUM INTO '/app/data/backup.db'\");d.close()"
docker compose -f deploy/docker-compose.yml cp platform:/app/data/backup.db ./backup.db
```

恢复到空部署：

```bash
docker compose -f deploy/docker-compose.yml stop platform
docker compose -f deploy/docker-compose.yml cp ./backup.db platform:/app/data/platform.db
docker compose -f deploy/docker-compose.yml run --rm --no-deps --user root \
  --entrypoint sh platform -c 'chown node:node /app/data/platform.db'
docker compose -f deploy/docker-compose.yml start platform
```

建议定期做恢复演练。

## 7. 安全检查清单

- `GAME_SECRET` 随机且不进入 Git。
- 只暴露 Caddy/反向代理；不要公开 worker 或 platform 端口。
- 生产环境使用 HTTPS，`COOKIE_SECURE=1`。
- SMTP 正常后关闭 `EMAIL_DEBUG`。
- `.env`、证书、数据库、日志不进版本控制。
- 单独备份数据库和证书。
- 日志不得包含密码、会话 token、隐藏手牌。
- 不要运行开放中继（open relay）SMTP 服务器。

> 频率限制按邮箱/账号而不是按来源 IP 计算。校园网 NAT 下所有玩家通常共享同一个公网 IP，按 IP 限制会误伤整批玩家。
