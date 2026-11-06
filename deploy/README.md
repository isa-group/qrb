# Deploying QRB on a VPS

One `docker compose` stack: Postgres, the store and gateway migrations, the API, the poller, the website, the gateway, and a Caddy proxy that terminates TLS on ports 80 and 443 with your own certificate. Only the proxy is published; everything else is on the private compose network.

```
internet ─ 80/443 ─ proxy (Caddy, your cert) ─ gateway:3001 ─┬─ /      → web:3000
                                                              └─ /api/* → api:8000 ─ postgres
                                                                 poller ─ postgres
```

## Before

1. **DNS:** an A record for your host name (e.g. `qbinder.score.es`) pointing at the VPS.
2. **Docker** with the compose plugin on the VPS; ports 80 and 443 open.
3. **Certificate:** the full chain and its key in one directory (e.g. `/home/operador`), readable by Docker.
4. **OAuth apps** with these callbacks:
   - GitHub: `https://<host>/api/auth/callback/github`
   - ORCID: `https://<host>/api/auth/callback/orcid`

## Deploy

```sh
git clone <repo> qrb && cd qrb && git checkout frontend-v2
cp deploy/.env.production.example .env      # fill in secrets, credentials and certificate file names
docker compose --profile proxy up -d --build    # or: task docker:prod
docker compose ps                               # migrations exited 0; gateway and proxy running
curl -sI https://<host> && curl -s https://<host>/api/health
```

The first start builds the images (several minutes). The poller fills the catalog within a couple of minutes; until then, binds fetch provider data live.

## Operate

- **Logs:** `docker compose logs -f gateway api poller proxy`
- **Update:** `git pull && docker compose --profile proxy up -d --build`
- **New certificate:** replace the files, then `docker compose restart proxy`.
- **Limits:** `.env` starts with `QRB_LIMITS_MODE=log` (would-be 429s are only logged as `limit_would_reject`); set `enforce` and restart the gateway when the numbers look right.
- **Backups:** the `pgdata` volume holds accounts, keys, history and stored catalogs, e.g. `docker compose exec postgres pg_dump -U qrb qrb > qrb.sql`.
