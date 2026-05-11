# `@itkujo/sms-edge` -- Design Spec

**Date:** 2026-05-10
**Status:** Approved (operator)
**Repo:** `itkujo/sms-edge` (private)
**Phase:** 3 of the SMS-infrastructure project (Phase 1 = SMSGate deploy, complete; Phase 2 = sms-core library, complete; Phase 3 = this bridge service)

---

## 1. Scope & architecture

### What `sms-edge` is

A small Node 20 HTTP service that sits between any Logto instance (via `connector-http-sms`) and our self-hosted SMSGate. It imports `@itkujo/sms-core` for all phone validation, abuse protection, rate limiting, error mapping, and template rendering. Each accepted Logto tenant has its own `X-Auth` token. An admin GUI (HTTP basic auth) lets you add and remove tenants without redeploying.

### What it isn't

- A general-purpose API gateway.
- A persistent store of sent messages. Audit events stream to stdout; they're not queryable from the bridge.
- A tenant-management system for any other service. It manages tokens for `POST /sms` access. That's it.
- A web framework. Around 400 lines of Node serving 6 endpoints (`POST /sms`, `GET /health`, `GET /admin`, `GET /admin/tenants`, `POST /admin/tenants`, `POST /admin/tenants/:name/delete`).

### Consumers

- **Logto instances** -- POST `connector-http-sms` JSON to `POST /sms` with their `X-Auth` token.
- **The bridge operator** -- uses `GET /admin/*` to add and remove tenants.
- **Orchestrator (Coolify, plain Docker, docker-compose)** -- hits `GET /health` for liveness probe.

### High-level diagram

```
                     +---------------------+
   Logto cloud  ---> | POST /sms           |
   (tenant A)        | X-Auth: <token-A>   |
                     |                     |
   Logto cloud  ---> |                     |
   (tenant B)        |     sms-edge        |       basic auth
   X-Auth: <token-B> | (Docker container)  | ----> SMSGate
                     |                     |       sms.relentnet.dev
   Operator     --> | GET /admin           |
   ADMIN_PASSWORD    | (manage tenants)    |
                     |                     |
   Orchestrator --> | GET /health          |
                     +----------|----------+
                                |
                          /data/tenants.json
                       (Docker volume)
```

### Relationship to other phases

- **Phase 1 -- SMSGate** is already deployed at `https://sms.relentnet.dev`. Out of scope here except as the downstream of the bridge.
- **Phase 2 -- `@itkujo/sms-core`** is published as a private GitHub git-URL package at `github:itkujo/sms-core#v0.1.0`. `sms-edge` imports it; that's the only runtime dependency.
- **Phase 4 -- inbound webhook handling (Zoho)** is a separate future service. SMSGate sends webhooks; `sms-edge` does not consume them. `sms-core` already ships `parseWebhookPayload` + `verifyWebhookSignature` ready for that consumer to use.

### Module / file layout

```
sms-edge/
├── package.json
├── tsconfig.json
├── tsup.config.ts        # builds ESM to dist/
├── vitest.config.ts
├── Dockerfile            # multi-stage alpine + Node 20
├── docker-compose.yml    # Coolify deployment manifest (pulls image from GHCR)
├── .dockerignore
├── .gitignore            # dist/, node_modules/, data/, .env
├── .gitattributes
├── README.md             # deploy + tenant onboarding runbook
├── .github/
│   └── workflows/
│       ├── ci.yml        # runs typecheck + tests + build on push/PR
│       └── release.yml   # publishes multi-arch image to GHCR on v* tag
├── src/
│   ├── index.ts          # composition root: parse env, build deps, start server
│   ├── server.ts         # http.createServer + minimal router
│   ├── config.ts         # env var parsing, fail-fast validation
│   ├── tenants/
│   │   ├── store.ts      # JSON-file store with atomic writes
│   │   ├── store.test.ts
│   │   ├── hash.ts       # scrypt-based token hashing and verification
│   │   └── hash.test.ts
│   ├── routes/
│   │   ├── sms.ts        # POST /sms handler
│   │   ├── sms.test.ts
│   │   ├── health.ts     # GET /health
│   │   ├── admin.ts      # GET/POST /admin/* + HTML templates
│   │   └── admin.test.ts
│   └── audit/
│       └── logger.ts     # onAuditLog adapter -> stdout JSON
└── test/
    └── e2e/
        └── server.test.ts  # full request/response round-trips with fake SmsClient
```

Each file has one responsibility. Tests colocated with implementation except for e2e which lives under `test/`.

### Dependencies

**Runtime:** one.

- `@itkujo/sms-core` (from `github:itkujo/sms-core#v0.1.0`).

Everything else uses Node built-ins:

- `node:http` for the server
- `node:crypto` for `scrypt` (token hashing), `randomBytes` (token generation), `timingSafeEqual` (constant-time compare)
- `node:fs/promises` for tenant file IO
- `node:path` for filesystem paths
- `node:async_hooks` (specifically `AsyncLocalStorage`) for request-id correlation

**Dev:** `typescript`, `tsup`, `vitest`, `@types/node`. Same set as sms-core.

### Engine and build target

- **Node:** `>=20.0`. Bumps from sms-core's `18.17` baseline because the bridge ships as a container -- we control the runtime. Node 20 gives us `--env-file` for local dev without `dotenv`.
- **TypeScript:** ES2022, ESM, strict mode (same flags as sms-core including `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`).
- **Build:** `tsup` emits ESM-only to `dist/index.js`. No CJS, no `.d.ts` -- nothing consumes this as a library.

Unlike sms-core, **`dist/` is not committed** to this repo. The bridge is consumed as a Docker image; the image's build stage runs `pnpm build`. PRs stay clean.

---

## 2. HTTP API surface

Six endpoints. All other paths return `404 Not Found`.

### `POST /sms` -- the data plane

Logto's HTTP SMS connector POSTs here.

**Request:**

```
POST /sms HTTP/1.1
Host: sms-edge.relentnet.dev
Content-Type: application/json
X-Auth: <tenant-token>

{
  "to": "+15551234567",
  "type": "SignIn",
  "payload": { "code": "123456" }
}
```

The body shape matches sms-core's `SendInput` exactly. `to`, `type`, `payload` are required; `ip` and `purpose` are optional (sms-core defaults `purpose` from `type`).

**Success (`200 OK`):**

```json
{ "ok": true, "messageId": "abc123", "deviceId": "dev-xxx", "state": "Pending" }
```

Body is sms-core's `SendResult` success arm verbatim. Logto only checks the 2xx status code; the body is included for operator debugging.

**Failure mapping** (`SmsError` -> HTTP status):

| `error.type` | Status | Notes |
|---|---|---|
| missing/invalid `X-Auth` | `401 Unauthorized` | bridge-level, before sms-core |
| body not parseable as JSON | `400 Bad Request` | from JSON.parse |
| missing/wrong-typed `to`/`type`/`payload` | `400 Bad Request` | bridge body validation |
| `InvalidPhone` | `400 Bad Request` | bad input from Logto |
| `PremiumPrefixBlocked` | `400 Bad Request` | bad input |
| `SequentialPatternBlocked` | `400 Bad Request` | bad input |
| `RateLimit` | `429 Too Many Requests` | with `Retry-After: <retryAfterSec>` header |
| `Provider` (status 4xx from SMSGate) | `502 Bad Gateway` | SMSGate rejected us |
| `Provider` (status 5xx from SMSGate) | `503 Service Unavailable` | SMSGate broken |
| `Network` | `503 Service Unavailable` | can't reach SMSGate |
| `Timeout` | `504 Gateway Timeout` | SMSGate too slow |
| `Config` | `500 Internal Server Error` | shouldn't happen at runtime; bug |

**Failure body shape:**

```json
{ "ok": false, "error": { "type": "InvalidPhone", "reason": "must start with +1" } }
```

The `error` field is sms-core's `SmsError` discriminated union, verbatim.

### `GET /health` -- liveness probe

```
GET /health HTTP/1.1

200 OK
{ "ok": true, "version": "0.1.0", "tenants": 3, "uptimeSec": 12345 }
```

No auth. Returns `200` if the server is up and the tenant store loaded cleanly. Returns `503` if the tenant file failed to load on boot.

**Does not probe SMSGate.** An SMSGate outage should not restart the bridge; Logto's retries are the right backpressure.

### `GET /admin` -- redirect

Basic auth gate (single user `admin`, password from `ADMIN_PASSWORD`). On success: `302 Location: /admin/tenants`.

### `GET /admin/tenants` -- list page

HTML page showing a table of configured tenants (name, created-at, delete button). Tokens themselves are not displayed -- only the hash is stored, plaintext is unrecoverable.

Each delete button POSTs to `/admin/tenants/:name/delete` with a CSRF token in a hidden field.

### `POST /admin/tenants` -- create

Form-encoded body: `name=<string>` plus the CSRF token. Server validates the name against `^[a-z0-9][a-z0-9-]{1,31}$`, generates a 32-byte URL-safe token via `randomBytes(32).toString('base64url')`, hashes it, writes to the store, then renders the **one-time token view**:

```
Tenant 'acme' created.

Token (shown once, save it now):
  <43-character token>

X-Auth header to configure in Logto:
  X-Auth: <token>

Logto connector URL:
  https://sms-edge.relentnet.dev/sms

[ Back to tenants ]
```

After this response, the plaintext token is gone from server memory. If lost: delete and recreate the tenant.

### `POST /admin/tenants/:name/delete` -- remove

CSRF-protected form POST. Removes the entry from `tenants.json`. Future requests with that token return `401`.

### CSRF on admin POSTs

The GET that renders a form embeds `<input type="hidden" name="csrf" value="<token>">`. The token is `HMAC-SHA256(ADMIN_PASSWORD, sessionFingerprint)` where `sessionFingerprint` is derived from the basic-auth credentials. POST handlers verify before mutating. Defends against malicious links that would otherwise trigger admin operations via cached basic auth.

### Things explicitly NOT in the surface

- No `GET /admin/tenants/:name` detail page -- nothing to show beyond the list row already provides.
- No tenant-rotate endpoint -- rotate via delete + recreate.
- No `PUT /admin/tenants/:name` edit -- nothing editable.
- No `GET /admin/audit` log viewer -- audit goes to stdout; use `docker logs sms-edge`.
- No `POST /admin/test-sms` test-send button -- deferred to v0.2.

---

## 3. Request lifecycle and validation

### `POST /sms` step-by-step

```
 1. Server reads headers                                   (server.ts)
 2. Server reads + size-limits body (max 16 KB; 413 on excess)
 3. Server parses JSON body                                (400 on parse error)
 4. Server validates X-Auth header                         (401 if missing)
 5. Tenant store: lookup by token                          (401 if no match)
 6. Bridge validates body shape (to/type/payload typing)   (400 on mismatch)
 7. Bridge emits audit event 'edge.request.received'
 8. Bridge calls SmsClient.send()                          (sms-core pipeline)
     -- sms-core emits 'send.attempt'
     -- sms-core runs validators
     -- sms-core checks rate limits
     -- sms-core renders template
     -- sms-core POSTs to SMSGate
     -- sms-core emits 'send.success' or 'send.blocked' or 'send.failure'
 9. Bridge maps SmsError -> HTTP status (see Section 2 table)
10. Bridge writes response
11. Bridge emits audit event 'edge.request.completed'     (status, duration)
```

Steps 7 and 11 are bridge-level audit events; events inside step 8 are sms-core's existing emissions. All flow through the same `onAuditLog` callback to stdout JSON.

### Body size limit

Hardcoded **16 KB**. Logto's typical body is under 1 KB. The server reads at most 16 KB into a buffer; anything larger gets `413 Payload Too Large` and the connection is dropped before the body is fully consumed.

Rationale: an attacker can't trigger memory pressure by streaming a multi-GB body before reaching the auth check.

### Bridge body validation

After JSON parse, before calling sms-core:

```ts
type BridgeValidationResult =
  | { ok: true; input: SendInput }
  | { ok: false; status: 400; reason: string }

function validateBody(body: unknown): BridgeValidationResult {
  if (!isObject(body)) return reject('body must be a JSON object')
  if (!isString(body.to)) return reject('field "to" must be a string')
  if (!isString(body.type)) return reject('field "type" must be a string')
  if (!isObject(body.payload)) return reject('field "payload" must be an object')
  if (body.ip !== undefined && !isString(body.ip))
    return reject('field "ip" must be a string when present')
  if (body.purpose !== undefined && body.purpose !== 'otp' && body.purpose !== 'transactional')
    return reject('field "purpose" must be "otp" or "transactional" when present')
  return { ok: true, input: body as SendInput }
}
```

The bridge defends the type boundary: raw JSON enters, a typed `SendInput` exits. It does NOT validate `to` as E.164 here -- that's sms-core's job.

**Implementation note:** the code blocks above use `body.to` for readability, but under `noUncheckedIndexedAccess` the implementer should use bracket access (`body['to']`) on `Record<string, unknown>` values to satisfy the typechecker. Same pattern used throughout sms-core's `webhooks/parse.ts`.

### Tenant lookup (timing-safe)

Tenant records:

```json
[
  { "name": "acme", "tokenHash": "scrypt$N=16384,r=8,p=1$<salt>$<key>", "createdAt": "2026-05-10T12:34:00Z" }
]
```

Lookup is O(n) over the array, comparing each hash against `scrypt(presentedToken)` with `timingSafeEqual`. For realistic n (1-50), this is sub-millisecond per check after the cache warms.

**Always iterate all tenants** regardless of early matches, to avoid timing leaks based on tenant ordering. If no tenant matches: `401 Unauthorized` with a generic body (no enumeration of valid names).

### Rate limiting interaction

`MemoryRateLimiter` from sms-core is constructed at boot with defaults (OTP: 3/phone/hr, 10/IP/hr; transactional: 30/phone/hr, 100/IP/hr).

**IP key.** sms-core's `SendInput.ip` is optional. The bridge sets it to `body.ip` if present, otherwise to the connecting peer's IP (which will be Logto's egress IP if Logto doesn't forward the end-user's IP). v0.1 does NOT trust `X-Forwarded-For`; that's explicitly deferred until the proxy-trust model is decided.

**Shared limiter across tenants.** A phone hitting the OTP limit cannot get further OTPs from any tenant for the next hour. This matches the user-protection lens: the phone owner's tolerance is the abuse cap, not per-tenant. Per-tenant isolation is a v0.2+ feature.

### Audit log shape

One JSON object per line on stdout:

```json
{"ts":"2026-05-10T12:34:56.789Z","level":"info","tenant":"acme","reqId":"req_abc123","event":"edge.request.received","method":"POST","path":"/sms","to":"+15551234567","type":"SignIn"}
{"ts":"2026-05-10T12:34:56.790Z","level":"info","tenant":"acme","reqId":"req_abc123","kind":"send.attempt","to":"+15551234567","type":"SignIn","purpose":"otp"}
{"ts":"2026-05-10T12:34:57.123Z","level":"info","tenant":"acme","reqId":"req_abc123","kind":"send.success","to":"+15551234567","messageId":"abc","type":"SignIn"}
{"ts":"2026-05-10T12:34:57.124Z","level":"info","tenant":"acme","reqId":"req_abc123","event":"edge.request.completed","status":200,"durationMs":335}
```

Common fields: `ts`, `level`, `tenant`, `reqId`. Per-event fields nested in. `level` defaults to `info`; bumps to `warn` on 4xx, `error` on 5xx.

**`reqId`**: every request gets `randomBytes(8).toString('hex')` (16 hex chars, prefixed `req_`). Threaded through all audit events for the request via `AsyncLocalStorage`.

**Top-level field discrimination:** bridge-level events use `event:` (e.g. `edge.request.received`). sms-core events use `kind:` (e.g. `send.attempt`). Two different field names so log filters don't collide.

**PII:** phone numbers in `to` appear in logs intentionally for debuggability. A future `redactPhone: true` tenant flag is deferred.

### Timeouts

- **Inbound (Logto -> bridge):** `server.requestTimeout = 30_000` (30s), `server.headersTimeout = 10_000` (10s).
- **Outbound (bridge -> SMSGate via sms-core):** `SmsClient` `timeoutMs: 15_000`.

### Graceful shutdown

On `SIGTERM`: stop accepting new connections, wait up to 10s for in-flight requests, then `process.exit(0)`. If anything still in-flight at 10s: `process.exit(1)` so the orchestrator knows.

---

## 4. Tenant store and token primitives

### On-disk file

Path: `/data/tenants.json`. The `/data` directory is mounted from a Docker volume.

```json
{
  "version": 1,
  "tenants": [
    {
      "name": "acme",
      "tokenHash": "scrypt$N=16384,r=8,p=1$<base64-salt>$<base64-derived-key>",
      "createdAt": "2026-05-10T12:34:56.789Z"
    }
  ]
}
```

Top-level `version: 1` for future migration. Empty initial state: `{ "version": 1, "tenants": [] }`.

### Hash format

Self-describing: `scrypt$N=16384,r=8,p=1$<base64-salt>$<base64-derived-key>`. Mirrors `passlib` / `crypt(3)` convention. Embeds the algorithm, parameters, salt, and derived key in one string. Verification needs only the stored hash (no parallel "what algorithm did we use" record), and a future algo change adds an `argon2id$...` arm without invalidating existing entries.

### `hash.ts` interface

```ts
// Returns a self-describing hash string ready for storage.
export async function hashToken(token: string): Promise<string>

// Constant-time verify against stored hash.
// Returns false (never throws) on malformed hash, unknown parameters, etc.
export async function verifyToken(token: string, stored: string): Promise<boolean>
```

Implementation: `crypto.scrypt(token, salt, 64, { N: 16384, r: 8, p: 1 })`. Salt is 16 bytes from `randomBytes`. Parameters chosen to take ~100ms on a modest VM.

### Token-verification cache

Per-request scrypt is too slow at scale. The bridge keeps an in-memory cache:

```
Map<sha256(token), { name: string; expiresAt: number }>
```

- Key: `SHA256(token)` (not the token itself -- a memory dump can't leak Logto secrets).
- Value: which tenant the token belongs to, plus a 5-minute expiry timestamp.
- Cleanup: on each lookup, drop expired entries (lazy eviction). No background timer.
- First request from a Logto pays the scrypt cost (~100ms). Subsequent requests within 5 minutes hit cache.

If scaling pain shows up beyond what the cache solves, the fallback knobs are (a) lower scrypt N, (b) add a `sha256` field alongside `tokenHash` in `tenants.json` so the verify loop is O(1) lookup + one scrypt instead of O(n) scrypts. Both are mechanical changes; defer.

### `store.ts` interface

```ts
interface Tenant {
  name: string
  tokenHash: string
  createdAt: string  // ISO-8601 UTC
}

interface TenantStore {
  list(): Promise<Tenant[]>
  add(name: string, tokenHash: string): Promise<void>             // throws if name exists
  remove(name: string): Promise<boolean>                          // returns whether it existed
  findByToken(presentedToken: string): Promise<Tenant | null>     // timing-safe
}

export async function openJsonStore(filePath: string): Promise<TenantStore>
```

### Atomic writes

```ts
async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  await fs.writeFile(tmp, content, { mode: 0o600 })
  await fs.rename(tmp, path)  // atomic on POSIX, same-filesystem
}
```

`tmp` lives in the same directory as `path`. POSIX `rename` is atomic same-filesystem. Worst case if killed mid-rename: tmp file orphaned; on next boot the store ignores `.tmp` siblings. Worst case if killed during `writeFile`: real file untouched.

File mode `0600` defends against misconfigured volume permissions.

### Concurrency

In-memory promise chain serializes writes:

```ts
class JsonStore implements TenantStore {
  private writeLock = Promise.resolve()
  
  async add(name: string, tokenHash: string): Promise<void> {
    this.writeLock = this.writeLock.then(() => this.doAdd(name, tokenHash))
    return this.writeLock
  }
}
```

Bridge is a single Node process; no external lockfile or `flock` needed.

### Boot sequence

```
1. Resolve TENANTS_PATH (default '/data/tenants.json')
2. Try to read file:
    - Not found:                         create with { version: 1, tenants: [] }
    - Found + parses + version === 1:   load tenants into memory
    - Found + unknown version:          refuse to start
    - Found + parse error:              refuse to start (log path)
3. Validate each tenant (name format, tokenHash non-empty, createdAt parseable):
    - Any invalid entry:                refuse to start
    - Duplicate names:                  refuse to start (corruption)
4. Hand store to the server
```

"Refuse to start" = log clear error to stderr, `process.exit(1)`. Orchestrator's restart loop signals the operator to inspect logs.

### Token generation

```ts
export function generateToken(): string {
  return randomBytes(32).toString('base64url')
}
```

43 chars, 256 bits of entropy. Example: `Hx_K8vw3hF1Lp2OqRsTuVwXyZ012345abcdefghij_k`.

### Failure modes

| Scenario | Behavior |
|---|---|
| `/data/tenants.json` missing | Auto-create empty store |
| Unreadable (permissions) | Refuse to start, log path |
| Corrupted JSON | Refuse to start, log path |
| Duplicate tenant names | Refuse to start |
| Unknown version | Refuse to start |
| Disk full on `add` | Throw; handler returns 500; in-memory state correct |
| File deleted while running | Bridge keeps serving from memory; next `add`/`remove` recreates |
| Concurrent `add` calls | Serialized via promise chain |

---

## 5. Dev, build, deploy

### Local dev

```bash
git clone git@github.com:itkujo/sms-edge.git
cd sms-edge
pnpm install
cp .env.example .env  # edit values
pnpm dev              # tsup --watch + node --watch --env-file=.env dist/index.js
```

`.env.example`:

```
# Inbound (admin GUI)
ADMIN_PASSWORD=change-me-min-16-chars

# Outbound (sms-core -> SMSGate)
SMSGATE_BASE_URL=https://sms.relentnet.dev
SMSGATE_USER=-HP3NQ
SMSGATE_PASS=change-me

# Server
PORT=3000
TENANTS_PATH=./data/tenants.json
LOG_LEVEL=info
```

No `dotenv` dependency: Node 20's `--env-file` is built in.

### Config parsing (`src/config.ts`)

```ts
export interface Config {
  port: number
  adminPassword: string
  smsgate: { baseUrl: string; username: string; password: string }
  tenantsPath: string
  logLevel: 'info' | 'warn' | 'error'
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config
```

Fail-fast at boot on:

- `ADMIN_PASSWORD` missing or shorter than 16 chars.
- `SMSGATE_USER`, `SMSGATE_PASS`, `SMSGATE_BASE_URL` missing.
- `PORT` set but not a valid integer.

Every failure throws a clear error at boot. No silent defaults for security-relevant vars.

### Build

```ts
// tsup.config.ts
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  outExtension: () => ({ js: '.js' }),
  dts: false,
  sourcemap: true,
  clean: true,
  target: 'node20',
})
```

ESM-only. No `.d.ts` because nothing imports the bridge as a library. `dist/` is gitignored.

### Tests

`vitest` with colocated `*.test.ts` files for units; one end-to-end test under `test/e2e/`. `pnpm test` runs everything.

### Dockerfile

```dockerfile
# Stage 1: build
FROM node:20-alpine AS builder
WORKDIR /build
RUN corepack enable
COPY pnpm-lock.yaml package.json ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN pnpm build

# Stage 2: runtime
FROM node:20-alpine AS runtime
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app -u 10001
COPY --from=builder /build/dist /app/dist
COPY --from=builder /build/node_modules /app/node_modules
COPY --from=builder /build/package.json /app/package.json
RUN mkdir -p /data && chown app:app /data
USER app
VOLUME ["/data"]
EXPOSE 3000
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
```

- Alpine base for size (~80 MB final).
- Non-root user (`app`, UID 10001).
- `/data` declared as a volume.
- `pnpm fetch` + `--offline` keeps the layer cache stable across code-only changes.

### `.dockerignore`

```
.git
node_modules
dist
data
.env
.env.*
*.log
test
docs
```

### GitHub Actions

**`.github/workflows/ci.yml`** -- on every push and PR:

```yaml
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - actions/checkout
      - actions/setup-node (Node 20, pnpm cache)
      - pnpm/action-setup
      - pnpm install --frozen-lockfile
      - pnpm typecheck
      - pnpm test
      - pnpm build
```

**`.github/workflows/release.yml`** -- on tag push `v*`:

```yaml
on:
  push:
    tags: ['v*']
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - actions/checkout
      - docker login to ghcr.io (using GITHUB_TOKEN)
      - docker buildx build --platform linux/amd64,linux/arm64
                            --tag ghcr.io/itkujo/sms-edge:${{ github.ref_name }}
                            --tag ghcr.io/itkujo/sms-edge:latest
                            --push .
```

Multi-arch matters because the bridge may run on x86 (Coolify VM), arm64 (dev machine, Pi), or both.

### Compose file -- the canonical deploy artifact

`docker-compose.yml` ships at the repo root. It is the single source of truth for how the bridge runs in production. Coolify, plain Docker, and any other compose-aware host all use the same file.

```yaml
# docker-compose.yml
services:
  sms-edge:
    image: ghcr.io/itkujo/sms-edge:${IMAGE_TAG:-latest}
    restart: unless-stopped
    environment:
      # Required secrets -- deployment fails if not set (Coolify highlights these in red).
      - ADMIN_PASSWORD=${ADMIN_PASSWORD:?}
      - SMSGATE_USER=${SMSGATE_USER:?}
      - SMSGATE_PASS=${SMSGATE_PASS:?}
      # Required with defaults -- prefilled but editable in Coolify UI.
      - SMSGATE_BASE_URL=${SMSGATE_BASE_URL:?https://sms.relentnet.dev}
      - LOG_LEVEL=${LOG_LEVEL:?info}
      # Hardcoded -- not surfaced in UI.
      - PORT=3000
      - TENANTS_PATH=/data/tenants.json
      # Coolify magic env: assigning a domain to this service in the UI sets
      # SERVICE_FQDN_SMS-EDGE_3000 and provisions a Traefik route + cert.
      # The bridge itself ignores it; the value being present is what Coolify
      # uses to wire up routing. (Identifier uses hyphens to match the service
      # name; see https://coolify.io/docs/knowledge-base/docker/compose#coolify-s-magic-environment-variables)
      - SERVICE_FQDN_SMS-EDGE_3000
    volumes:
      - sms-edge-data:/data
    ports:
      - "3000:3000"
    healthcheck:
      test: ["CMD-SHELL", "node -e \"fetch('http://localhost:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))\""]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 5s

volumes:
  sms-edge-data:
```

Key choices in the compose file:

- **`image:` not `build:`** -- Coolify pulls the prebuilt image from GHCR rather than building each deploy. CI builds the image once on tag push (`v0.1.0`) and reuses the same image bytes across every host. Faster deploys, deterministic.
- **`IMAGE_TAG` env override** -- defaults to `latest` for casual deploys; Coolify operators set `IMAGE_TAG=v0.1.0` (or whatever) in the Coolify UI for pinned, reproducible deploys.
- **Required-variable syntax (`${VAR:?}` and `${VAR:?default}`)** -- Coolify recognizes Docker Compose's standard required-variable syntax and refuses to deploy until missing values are filled in. Variables marked required appear at the top of Coolify's env-var UI with a red border when empty; required-with-default variables are prefilled but editable. This is more operator-friendly than letting the container boot, fail in `loadConfig`, and crash-loop. See [Coolify docs on required env vars](https://coolify.io/docs/knowledge-base/docker/compose#required-environment-variables).
- **The bridge's `loadConfig` is still the source of truth.** It re-validates every var at runtime. Compose's `${VAR:?}` is a pre-flight check; `loadConfig` is the safety net for hosts that don't honor it (raw docker-compose without Coolify).
- **Healthcheck uses Node + native `fetch`** -- alpine doesn't ship curl by default, and Node 20 has `fetch` global. Avoids bloating the image. Coolify uses this same healthcheck for its in-UI status indicator.
- **`SERVICE_FQDN_SMS-EDGE_3000`** is Coolify's magic env var. The naming convention is `SERVICE_FQDN_<identifier>_<port>` where the identifier uses **hyphens, not underscores**, to match the service name. (Underscores in the identifier are not supported when including a port -- a Coolify-documented limitation.) The bridge itself never reads this env var; Coolify uses its mere presence in the compose file to know "assign a domain to this service in the UI and wire it through Traefik." On a non-Coolify host the variable is simply unset and Docker silently drops it from the container environment.
- **Named volume `sms-edge-data`** persists `/data/tenants.json` across container restarts. Coolify creates this volume automatically the first time you deploy; on a plain Docker host, `docker compose up` creates it.

### Operator runbook -- Coolify (compose deploy)

1. **Build the image once.** Push a `v*` tag to the `sms-edge` repo on GitHub. The `release.yml` workflow builds + pushes `ghcr.io/itkujo/sms-edge:v0.1.0` and `:latest` (multi-arch).
2. **In Coolify:** Create a new resource -> "Docker Compose" -> point at the `sms-edge` repo (or paste the compose file contents). Coolify reads `docker-compose.yml` from the repo root.
3. **Configure env vars in the Coolify UI.** Coolify auto-detects every variable referenced in the compose file and lists them with red borders for the required ones. Set:
   - `ADMIN_PASSWORD` (required) -- generate with `openssl rand -base64 24`
   - `SMSGATE_USER` (required) -- `-HP3NQ`
   - `SMSGATE_PASS` (required) -- from your password manager
   - `SMSGATE_BASE_URL` (required, prefilled `https://sms.relentnet.dev`) -- leave as-is
   - `LOG_LEVEL` (required, prefilled `info`) -- leave as-is, or set to `warn`/`error`
   - `IMAGE_TAG` (optional) -- `v0.1.0` for pinned deploys, omit for `latest`
   - `SERVICE_FQDN_SMS-EDGE_3000` -- `sms-edge.relentnet.dev` (Coolify-managed Traefik will issue a cert and route the domain to port 3000). Note: hyphen in the env-var name to match the service identifier.
4. **Coolify needs to pull from a private GHCR image.** Add `ghcr.io` as a registry in Coolify's settings with a GitHub PAT (scope: `read:packages`). One-time setup per Coolify install. Coolify documents this flow.
5. **Deploy.** Coolify clones the repo, reads `docker-compose.yml`, fills in env vars, runs `docker compose pull && docker compose up -d`. Healthcheck flips to green after ~5s.
6. **Verify** by curling `https://sms-edge.relentnet.dev/health` -- should return `{"ok":true, "version":"0.1.0", ...}`.
7. **Visit `https://sms-edge.relentnet.dev/admin`**, log in as `admin` + `ADMIN_PASSWORD`.
8. **Add first tenant**, copy the one-time token.
9. **In Logto admin:** configure HTTP SMS connector with URL `https://sms-edge.relentnet.dev/sms` and header `X-Auth: <token>`.
10. **In Logto:** trigger a test SMS via the connector test button or a real sign-in flow.

### Operator runbook -- generic Docker host (compose)

The same `docker-compose.yml` works on any Docker-compose-aware host. Set the required env vars in a `.env` file next to the compose file, then bring up:

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
docker compose logs -f sms-edge   # confirm "listening on :3000"
```

Then put a reverse proxy (Caddy, Traefik, nginx) in front of `localhost:3000` to terminate TLS. README ships with a sample Caddyfile.

To deploy a different tag: edit `IMAGE_TAG` in `.env`, `docker compose pull && docker compose up -d`. To remove the bridge entirely: `docker compose down -v` (the `-v` also drops the tenants volume -- omit if you want to keep tenants for a future redeploy).

### Versioning

- v0.1.0 -- first tagged release meeting success criteria (Section 6).
- v0.x -- additive.
- v1.0.0 -- after one production deploy with >1 week of uptime serving real Logto traffic.

---

## 6. Out of scope, risks, success criteria

### Out of scope for v0.1.0

- **Per-tenant rate limit overrides.** All tenants share one `MemoryRateLimiter` with sms-core's defaults.
- **Per-tenant audit query / log viewer.** Audit goes to stdout; query via `docker logs`. A `/admin/audit` page is a real feature deserving its own design pass.
- **Per-tenant analytics** (sends today, success rate). Same reason; deferred.
- **Tenant token rotation in place.** To rotate: delete + recreate the tenant.
- **A second SMS provider.** Bridge talks only to SMSGate via sms-core. Adding fallback providers is a sms-core concern.
- **Inbound SMS routing.** SMSGate sends `sms:received` webhooks; bridge does NOT consume them. A future `sms-inbound` service will use sms-core's `parseWebhookPayload` + `verifyWebhookSignature`.
- **WebSocket / SSE for live admin GUI updates.** Plain HTML form posts + page reloads.
- **i18n.** English only.
- **Test-send button from admin** (`POST /admin/test-sms`). Useful but defer; curl works during initial setup.
- **Full security-header hardening** (CSP, X-Frame-Options, HSTS). Set `X-Content-Type-Options: nosniff` and `Cache-Control: no-store` on admin responses; defer the rest.
- **A real `RedisRateLimiter` implementation.** sms-core ships the stub. Only needed when scaling to multiple bridge replicas.
- **Multiple bridge replicas behind a load balancer.** Single replica only in v0.1.

### Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Logto's `connector-http-sms` envelope changes upstream | Low | sms-core's `SendInput` is a superset of Logto's; bridge validates field presence, not exact shape |
| scrypt verification too slow with many tenants | Low | Token cache (Section 4); fallback is lowering N or adding an O(1) lookup index |
| Container restarts lose in-memory rate-limit state | Medium | Acceptable for v0.1 (single replica); documented in README; v0.2 = RedisRateLimiter |
| Container restarts lose token verification cache | Low | First request after restart pays 100ms; self-recovering |
| Admin GUI compromised (weak `ADMIN_PASSWORD`) | Medium | Fail-fast on `< 16` chars; HTTPS via proxy + CSRF; README documents `openssl rand -base64 24` |
| Tenant token leaked via one-time-view page misuse | Medium | One-time display is mitigation, not prevention; delete + recreate if compromised; GUI copy explains it |
| Disk full -> `add` fails | Low | `add` throws; handler returns 500; existing tenants in memory still work; alert via host monitors |
| Logto POSTs over HTTP not HTTPS | Low | Proxy terminates TLS; README documents "do not expose port 3000 directly" |
| Multi-arch Docker build fails for arm64 | Low | CI catches it on every tag |
| Time zone confusion in `createdAt` | Low | ISO-8601 UTC everywhere; GUI displays UTC; README documents |
| Dev/test pollutes real SMSGate | Low | Integration tests gated by env var; unit tests use fake `SmsClient` |
| `X-Forwarded-For` spoofing for rate-limit bypass | Low (v0.1 hardcodes no XFF trust) | Bridge uses the connecting peer IP only; XFF trust is explicitly NOT in v0.1 |

### Success criteria

The bridge is "done" for v0.1.0 when:

1. All endpoints from Section 2 implemented and tested.
2. Every module has unit tests (`tenants/store`, `tenants/hash`, `routes/sms`, `routes/admin`, `audit/logger`, `config`).
3. One end-to-end test exercises `POST /sms` happy path with a fake `SmsClient`.
4. One end-to-end test exercises admin tenant add/list/delete.
5. `pnpm typecheck`, `pnpm test`, `pnpm build` all clean.
6. Dockerfile builds locally without error.
7. Multi-arch CI build on `v*` tag succeeds; image pushed to `ghcr.io/itkujo/sms-edge`.
8. **Live integration:**
   - `docker-compose.yml` deploys to Coolify (via the compose flow, pulling `ghcr.io/itkujo/sms-edge:v0.1.0`) at `sms-edge.relentnet.dev`.
   - Healthcheck reports healthy in the Coolify UI; `GET /health` returns `200`.
   - First tenant created via admin GUI.
   - `curl -H "X-Auth: <token>" -d '...' https://sms-edge.relentnet.dev/sms` triggers a real SMS.
   - A Logto instance configured against the bridge sends a real SMS during a sign-in flow.
9. Operator runbook in README is complete enough that a fresh-eyes deploy works without referring to the spec.
10. The verification-before-completion skill's checklist is satisfied: real test runs, no "should work" claims.

---

## Appendix: relationship to sms-core

| Concern | sms-core | sms-edge |
|---|---|---|
| Phone validation (E.164, NANP rules) | Yes | Calls into sms-core |
| Premium-prefix / pattern abuse blocks | Yes | Calls into sms-core |
| Rate limiting | `MemoryRateLimiter` class | Constructs one instance, hands to `SmsClient` |
| Template rendering | `defaultTemplateRenderer` | Calls into sms-core |
| SMSGate HTTP client | `SmsClient` | Constructs one, calls `.send()` |
| HTTP server | Out of scope | This service |
| Auth (X-Auth header, tenants, scrypt) | Out of scope | This service |
| Admin GUI | Out of scope | This service |
| Audit -> stdout JSON | Hook only (`onAuditLog`) | Adapter wired into `SmsClient` |
| Webhook payload parsing | `parseWebhookPayload` | Out of scope for sms-edge; a future `sms-inbound` service will use it |
| Webhook signature verification | `verifyWebhookSignature` | Same as above |

sms-edge is sms-core's first real consumer. Any gap discovered during sms-edge implementation (e.g. an `SmsError` variant the bridge can't cleanly map, or a missing audit field) is raised against sms-core for v0.2 -- not papered over in the bridge.
