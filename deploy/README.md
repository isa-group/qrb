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

## Monitoring (Prometheus and Grafana over Tailscale)

The `monitoring` profile adds Prometheus, Grafana, postgres-exporter and node-exporter. None of them is reachable from the internet: Prometheus and the exporters are on the compose network only, the gateway serves `/metrics` on an internal port (`METRICS_PORT`, 9091) that the proxy never routes, and Grafana listens on `127.0.0.1:3002`. You reach Grafana over [Tailscale](https://tailscale.com).

```
tailnet ─ tailscale serve :8443 ─ grafana (127.0.0.1:3002) ─┬─ prometheus ─┬─ gateway:9091/metrics
                                                             │              ├─ postgres-exporter
                                                             │              └─ node-exporter (host)
                                                             └─ postgres (grafana_ro: read-only, no auth tables)
```

1. **Tailscale** on the VPS and on your laptop, both signed in to the same tailnet:
   `curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up`
2. **Secrets** in `.env`: `GRAFANA_ADMIN_PASSWORD`, `GRAFANA_DB_PASSWORD`, `QRB_EXPORTER_PASSWORD` (each `openssl rand -hex 24`).
3. **Start:** `docker compose --profile proxy --profile monitoring up -d --build` (or `task docker:monitoring` once the main stack runs). The one-shot `monitoring-init` creates the read-only roles from `deploy/monitoring/roles.sql`; Grafana does not start if a password is missing.
4. **Expose Grafana on the tailnet only:**
   `sudo tailscale serve --bg --https=8443 http://127.0.0.1:3002`
   then open `https://<vps>.<tailnet>.ts.net:8443` (Tailscale provides the certificate) and set `GRAFANA_ROOT_URL` to that URL. Sign in as `admin` with `GRAFANA_ADMIN_PASSWORD`.
   Without Tailscale: `ssh -L 3002:127.0.0.1:3002 <vps>` and open `http://localhost:3002`.

The **QRB overview** dashboard shows request rate by status, p95 latency per route, 429s and 5xx per minute, how old the queue data and each QPU's calibration are, units used per day, and host CPU, memory and disk. Prometheus keeps 30 days (`PROMETHEUS_RETENTION`).

Check that nothing leaked: `curl -s -o /dev/null -w '%{http_code}' https://<host>/metrics` and `.../api/metrics` both answer 404, and `ss -tlnp | grep -E '3002|9090|9091'` shows only `127.0.0.1:3002`.
