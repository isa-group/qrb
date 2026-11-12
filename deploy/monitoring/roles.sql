-- Monitoring roles, applied by the one-shot `monitoring-init` service on every
-- `docker compose --profile monitoring up` (idempotent). Run as the qrb owner after
-- both the gateway and store migrations, so every table below exists.
--
--   qrb_exporter  postgres-exporter: server statistics only (pg_monitor), no table data.
--   grafana_ro    Grafana's Postgres datasource: SELECT on catalog, activity and quota
--                 tables only. No access to Better Auth's tables (user, session, account,
--                 apikey, verification) or to the admin tables.
--
-- Passwords come in as psql variables (-v exporter_password=... -v grafana_password=...).

SELECT format('CREATE ROLE qrb_exporter LOGIN PASSWORD %L', :'exporter_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qrb_exporter') \gexec
SELECT format('CREATE ROLE grafana_ro LOGIN PASSWORD %L', :'grafana_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_ro') \gexec

-- Keep passwords in sync with .env when they change.
ALTER ROLE qrb_exporter PASSWORD :'exporter_password';
ALTER ROLE grafana_ro PASSWORD :'grafana_password';

GRANT pg_monitor TO qrb_exporter;

-- Read-only, and only what the dashboards need.
ALTER ROLE grafana_ro SET default_transaction_read_only = on;
ALTER ROLE grafana_ro SET statement_timeout = '30s';
GRANT CONNECT ON DATABASE qrb TO grafana_ro;
GRANT USAGE ON SCHEMA public TO grafana_ro;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM grafana_ro;
GRANT SELECT ON
  catalog_status, catalog_resource, catalog_telemetry, binding_log,
  request_log, quota_user_daily
TO grafana_ro;
