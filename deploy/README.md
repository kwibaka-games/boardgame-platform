# Deployment files

- `docker-compose.yml` — platform + optional Caddy edge.
- `Caddyfile` — HTTPS reverse proxy example.
- `.env.example` — copy to `.env` and fill in; never commit `.env`.
- `issue-cert.sh` — optional Let's Encrypt helper (DNS-01/manual/aliyun).

Full instructions:

- [English deployment guide](../docs/en/deployment.md)
- [中文部署指南](../docs/zh-CN/deployment.md)

Quick Docker start:

```bash
cp deploy/.env.example deploy/.env
chmod 600 deploy/.env
docker compose -f deploy/docker-compose.yml --profile edge up -d --build
```

Certificates belong in `deploy/certs/` and are gitignored. Set
`EMAIL_DEBUG=0` and configure SMTP for a public deployment. There are no
seeded users; the first verified account is administrator unless
`ADMIN_EMAIL` is set.
