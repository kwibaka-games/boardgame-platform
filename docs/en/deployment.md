# Deployment

This guide deploys the platform as a small self-hosted site. It assumes a
Linux/macOS host with Docker Engine, Docker Compose v2, and a domain whose TLS
certificate you control.

## 1. Requirements

- Node.js **24+** for local development; Docker builds its own Node runtime.
- Docker Engine + Compose v2.
- A DNS name pointing at the host (or a LAN address).
- A TLS certificate for that name if users access it over HTTPS.
- Optional: an SMTP account for real email verification.

The platform exposes one browser-facing origin (Caddy or another reverse proxy).
Game workers are child processes and never receive a public port.

## 2. Clone with game submodules

Games live in separate repositories and are pinned as git submodules:

```bash
git clone --recurse-submodules https://github.com/ZangXuanyi/kwibaka-boardgame-platform.git
cd kwibaka-boardgame-platform

# If you cloned without --recurse-submodules:
git submodule update --init --recursive

# Browser game bundles are generated from the game submodules.
npm run sync-games
```

Do not edit generated `web/games/*.js` or `web/games/ice/` files; change the
game repository and run `npm run sync-games` again.

## 3. Environment

Copy the example and edit it:

```bash
cp deploy/.env.example deploy/.env
chmod 600 deploy/.env
```

Important variables:

| Variable | Purpose |
|---|---|
| `PUBLIC_ORIGIN` | Canonical browser origin, exactly matching the address bar. |
| `PUBLIC_ORIGINS` | Optional comma-separated extra exact origins (for IP/port tests). |
| `COOKIE_SECURE` | `1` behind HTTPS, `0` only for plain HTTP local tests. |
| `GAME_SECRET` | Shared secret between platform and game workers. Generate a long random value. |
| `SESSION_TTL_HOURS` | Login session lifetime. |
| `ADMIN_EMAIL` | Optional email that becomes administrator on registration. |
| `EMAIL_DEBUG` | `1` shows verification codes in the UI/log; never use for a public site. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | Real email delivery. |
| `DB_PATH` | SQLite path inside the platform container (default `/app/data/platform.db`). |

Never commit `deploy/.env`, `deploy/certs/`, SMTP passwords, or generated
session/data directories. `.gitignore` already excludes them.

### SMTP

For QQ Mail, use an SMTP authorization code (not the account password):

```env
SMTP_HOST=smtp.qq.com
SMTP_PORT=465
SMTP_SECURE=1
SMTP_USER=you@foxmail.com
SMTP_PASS=<QQ SMTP authorization code>
MAIL_FROM=you@foxmail.com
EMAIL_DEBUG=0
```

For a custom domain such as `no-reply@example.com`, use a transactional email
provider and configure its SPF/DKIM/DMARC records. A local SMTP server is not a
production delivery path by itself: consumer/campus IPs often cannot deliver to
external mailboxes and are rejected for missing PTR/reputation.

## 4. Local development (no Docker)

```bash
npm install
EMAIL_DEBUG=1 PORT=8080 DB_PATH="$PWD/data/dev.db" npm run dev:platform
```

Open `http://127.0.0.1:8080`. There are **no seeded test accounts**: register an
email, verify the code, and log in. The first verified account becomes admin
unless `ADMIN_EMAIL` reserves that role for a specific address.

Useful checks:

```bash
npm test
npm run build
npm run fuzz:ice -- 1000
```

## 5. Docker Compose

```bash
cp deploy/.env.example deploy/.env
# edit deploy/.env, then:
docker compose -f deploy/docker-compose.yml --profile edge up -d --build
```

This starts:

- `platform` on internal `8080`;
- `caddy` publishing `80` and `443`, terminating TLS and proxying to platform.

Put the certificate and key at `deploy/certs/fullchain.pem` and
`deploy/certs/key.pem` (mounted read-only). For an example Caddyfile, see
`deploy/Caddyfile`.

If you use another reverse proxy, start only the platform service:

```bash
docker compose -f deploy/docker-compose.yml up -d --build platform
```

and proxy to `127.0.0.1:8080` from your own web server.

### First administrator

The first verified registration becomes administrator. Alternatively set
`ADMIN_EMAIL` before registration, or create a verified bootstrap account:

```bash
docker compose -f deploy/docker-compose.yml exec platform \
  node dist/cli/add-user.js you@example.com YourName 'a-long-password' --admin
```

### Updating

```bash
git pull
git submodule update --init --recursive
npm run sync-games
docker compose -f deploy/docker-compose.yml --profile edge up -d --build
```

The database is in the `platform-data` Docker volume and survives rebuilds.
Never run two platform instances against the same SQLite database.

## 6. Backup and restore

Stop-free logical backup:

```bash
docker compose -f deploy/docker-compose.yml exec platform \
  node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/app/data/platform.db');d.exec(\"VACUUM INTO '/app/data/backup.db'\");d.close()"
docker compose -f deploy/docker-compose.yml cp platform:/app/data/backup.db ./backup.db
```

Restore into an empty deployment:

```bash
docker compose -f deploy/docker-compose.yml stop platform
docker compose -f deploy/docker-compose.yml cp ./backup.db platform:/app/data/platform.db
docker compose -f deploy/docker-compose.yml run --rm --no-deps --user root \
  --entrypoint sh platform -c 'chown node:node /app/data/platform.db'
docker compose -f deploy/docker-compose.yml start platform
```

Test restores periodically.

## 7. Security checklist

- Keep `GAME_SECRET` random and out of git.
- Keep only Caddy/reverse proxy exposed; never publish worker or platform ports.
- Set `COOKIE_SECURE=1` and use HTTPS in production.
- Keep `EMAIL_DEBUG=0` once SMTP works.
- Keep `.env`, certificates, database, and logs out of version control.
- Back up the database and certificate separately.
- Logs must not contain passwords, session tokens, or hidden game state.
- Do not run an open SMTP relay.
