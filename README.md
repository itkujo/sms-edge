# @itkujo/sms-edge

HTTP bridge from Logto's `connector-http-sms` to our self-hosted SMSGate, using `@itkujo/sms-core` for validation, abuse protection, rate limiting, and template rendering.

## Architecture

- `POST /sms` accepts Logto's `connector-http-sms` envelope and forwards to SMSGate.
- `GET /admin` (basic auth) manages per-tenant `X-Auth` tokens.
- `GET /health` returns liveness for orchestrator probes.
- Each tenant gets its own random 256-bit token; tokens are stored hashed (scrypt) on disk in `/data/tenants.json`.

See `docs/superpowers/specs/2026-05-10-sms-edge-design.md` for the full design.

## Deploy -- Coolify (via docker-compose)

1. Push a `v*` tag (e.g. `v0.1.0`) to the repo on GitHub. The Release workflow builds and pushes `ghcr.io/itkujo/sms-edge:<tag>` and `:latest` (multi-arch).
2. In Coolify: create a new resource -> "Docker Compose" -> point at this repo. Coolify reads `docker-compose.yml` from the repo root.
3. Add `ghcr.io` as a registry in Coolify's settings with a GitHub PAT (scope: `read:packages`). One-time per Coolify install.
4. In the Coolify env-var UI, set the variables Coolify auto-detected from the compose file:
   - `ADMIN_PASSWORD` (required) -- generate with `openssl rand -base64 24`. The admin username is fixed to `admin` and is not configurable.
   - `SMSGATE_USER` (required) -- your SMSGate basic-auth username.
   - `SMSGATE_PASS` (required) -- your SMSGate basic-auth password.
   - `SMSGATE_BASE_URL` (optional, prefilled `https://sms.relentnet.dev`).
   - `LOG_LEVEL` (optional, prefilled `info`).
   - `IMAGE_TAG` (optional) -- pin to a specific version, e.g. `v0.1.0`.
   - `SERVICE_FQDN_SMS-EDGE_3000` -- the domain Coolify will route to this service, e.g. `sms-edge.relentnet.dev`. Hyphen in the env-var name matches the service identifier.
5. Deploy.
6. Verify: `curl https://sms-edge.relentnet.dev/health` should return `{"ok":true,"version":"0.1.0","tenants":0,"uptimeSec":N}`.
7. Visit `https://sms-edge.relentnet.dev/admin`, log in as `admin` + `ADMIN_PASSWORD`, add your first tenant.
8. Copy the one-time token shown after creating the tenant. (You cannot retrieve it later.)
9. In Logto admin: configure the HTTP SMS connector with URL `https://sms-edge.relentnet.dev/sms` and header `X-Auth: <token>`.
10. Trigger a test SMS from Logto.

## Deploy -- generic Docker host (compose)

```bash
git clone git@github.com:itkujo/sms-edge.git
cd sms-edge
cat > .env <<EOF
IMAGE_TAG=v0.1.0
ADMIN_PASSWORD=$(openssl rand -base64 24)
SMSGATE_USER=-HP3NQ
SMSGATE_PASS=<from-password-manager>
EOF
docker compose pull
docker compose up -d
docker compose logs -f sms-edge   # confirm "edge.boot.listening"
```

Then put a reverse proxy (Caddy, Traefik, nginx) in front of `localhost:3000` to terminate TLS.

### Sample Caddyfile

```
sms-edge.example.com {
  reverse_proxy localhost:3000
}
```

## Dev

```bash
pnpm install
cp .env.example .env  # edit values
pnpm dev
```

The dev script runs `tsup --watch` + `node --watch --env-file=.env dist/index.js`. Changes to `src/` rebuild and restart automatically.

Note: `.env.example` sets `TENANTS_PATH=./data/tenants.json` (host-relative) for local dev. Production containers use `/data/tenants.json` (the compose volume mount).

## Tests

```bash
pnpm test            # unit + e2e
pnpm typecheck       # tsc --noEmit
pnpm build           # tsup -> dist/
```

## Configuration

| Env var | Required | Default | Notes |
|---|---|---|---|
| `ADMIN_PASSWORD` | yes | -- | Min 16 chars. Generate with `openssl rand -base64 24`. |
| `SMSGATE_USER` | yes | -- | SMSGate basic-auth username. |
| `SMSGATE_PASS` | yes | -- | SMSGate basic-auth password. |
| `SMSGATE_BASE_URL` | yes | `https://sms.relentnet.dev` | SMSGate server URL. |
| `PORT` | no | `3000` | Bind port. |
| `TENANTS_PATH` | no | `/data/tenants.json` | Tenant store file path. |
| `LOG_LEVEL` | no | `info` | `info` / `warn` / `error`. |

## Operations

### View logs

`docker logs sms-edge` (or `docker compose logs sms-edge`). Logs are one-line JSON.

### Add a tenant

Visit `/admin/tenants` -> Add tenant -> name it -> copy the one-time token.

### Rotate a token

Delete the tenant in `/admin/tenants`, recreate it, update Logto with the new token. This causes a brief window of 401s on `/sms` for that tenant; schedule during a quiet period.

### Upgrade

Bump `IMAGE_TAG` to the new version (Coolify env-var UI) and re-deploy. On a generic Docker host: `docker compose pull && docker compose up -d`. Graceful shutdown drains in-flight requests up to 10 seconds before the new container takes over.

### Backup tenants

Copy `/data/tenants.json` from the container's volume. Restoring is the reverse.

### Force rebuild

If `tenants.json` becomes corrupted, the bridge refuses to start with a clear error pointing at the path. Inspect the file, fix or replace it, restart the container.

## Limitations (v0.1)

- Single replica only. State (rate limits, token cache) is per-process; multiple replicas would diverge. Use a load balancer with sticky sessions if you ever scale out (not recommended -- run a single replica per SMSGate device).
- No per-tenant rate-limit overrides. All tenants share one limiter with sms-core defaults.
- No `/admin/audit` page; query via `docker logs`.
- Tenant tokens cannot be rotated in place; delete + recreate.

## License

UNLICENSED (private).
