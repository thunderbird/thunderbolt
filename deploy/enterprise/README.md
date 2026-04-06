# Thunderbolt Enterprise Deployment

Self-hosted Thunderbolt on AWS ECS Fargate with OIDC authentication via Keycloak.

## Architecture

### AWS (Fargate)

```
                    ┌─────────────────────────────────────┐
                    │            ALB (public)             │
                    │  /v1/*  → Backend                   │
                    │  /auth/* → Keycloak                 │
                    │  /powersync/* → PowerSync           │
                    │  /*     → Frontend (nginx)          │
                    └─────┬───────┬───────┬───────┬───────┘
                          │       │       │       │
               ┌──────────┘  ┌────┘  ┌────┘  ┌────┘
               ▼             ▼       ▼       ▼
          ┌──────────┐  ┌─────────┐ ┌────┐ ┌──────────┐
          │ Frontend │  │ Backend │ │ KC │ │PowerSync │
          │ (nginx)  │  │ (Bun)   │ │    │ │          │
          └──────────┘  └────┬────┘ └────┘ └────┬─────┘
                            │                   │
                       ┌────┴────┐         ┌────┴────┐
                       │Postgres │         │ MongoDB │
                       │(WAL on) │         │(rs0)    │
                       └─────────┘         └─────────┘
```

All services run on Fargate. Postgres and MongoDB use EFS for persistence.
Internal service discovery via AWS Cloud Map (`*.thunderbolt.local`).

### Local (docker-compose)

```
  Browser (localhost:3000)
      │
      ▼
  ┌─────────┐    ┌──────────────┐    ┌──────────┐
  │ Frontend │───▶│   Backend    │───▶│ Postgres │
  │ (nginx)  │    │ (host network)│   │ (:5434)  │
  │ (:3000)  │    │   (:8000)    │   └──────────┘
  └─────────┘    └──────┬───────┘
                        │          ┌──────────┐
  ┌──────────┐          ├─────────▶│PowerSync │
  │ Keycloak │◀─────────┘          │ (:8081)  │
  │ (:8180)  │                     └────┬─────┘
  └──────────┘                          │
                                   ┌────┴────┐
                                   │ MongoDB │
                                   │(:27017) │
                                   └─────────┘
```

The backend runs with `network_mode: host` locally so it can reach both
Keycloak (`localhost:8180`) and the Docker services via their exposed ports.
This solves the classic OIDC-in-Docker problem where both the browser and backend
need to reach Keycloak at the same URL.

## Containers

| Service | Image | Port | Purpose |
|---------|-------|------|---------|
| Frontend | Custom (nginx) | 80 | Static SPA + COEP/COOP headers + `/v1/*` proxy |
| Backend | Custom (Bun) | 8000 | API server (runs interpreted, not compiled) |
| PostgreSQL | Custom (postgres:18-alpine + init SQL) | 5432 | Primary database (WAL logical replication) |
| MongoDB | mongo:7.0 | 27017 | PowerSync storage backend (replica set) |
| PowerSync | Custom (journeyapps/powersync-service + config) | 8080 | Real-time sync |
| Keycloak | quay.io/keycloak/keycloak:26.0 | 8080 | OIDC identity provider |

## Local Testing

### Prerequisites

- Docker Desktop
- No conflicting services on ports 3000, 8000, 8180, 5434, 8081

### Quick Start

```bash
cd deploy/enterprise
cp .env.example .env
# Optionally edit .env to add API keys for inference providers

docker compose up --build
```

### Access

| Service | URL | Credentials |
|---------|-----|-------------|
| App | http://localhost:3000 | (via Keycloak SSO) |
| Keycloak admin | http://localhost:8180 | admin / admin |
| Demo user | (Keycloak login) | demo@thunderbolt.so / demo |

### Stopping

```bash
docker compose down        # stop containers, keep data
docker compose down -v     # stop containers + delete volumes (clean slate)
```

### Port Conflicts

If you have the dev PowerSync stack running, the default enterprise ports avoid
conflicts (5434 for Postgres, 8081 for PowerSync). Edit `.env` to change any port:

```
FRONTEND_PORT=3000
BACKEND_PORT=8000
KEYCLOAK_PORT=8180
POSTGRES_PORT=5434
POWERSYNC_PORT=8081
```

### Keycloak + Docker Networking

Keycloak is configured with `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true` (Keycloak v2
hostname config). This allows:

- **Browser**: reaches Keycloak at `localhost:8180` (frontchannel)
- **Backend**: reaches Keycloak at `keycloak:8080` (backchannel, Docker network)

The OIDC metadata returned to browsers uses `localhost:8180` URLs. The backend's
token exchange requests use the internal Docker hostname. Both work without
conflicting issuer URLs.

### Database Migrations

Drizzle migrations run automatically when the backend container starts
(via `entrypoint.sh`). No manual migration step needed.

## Deploy to AWS

### Prerequisites

- AWS account with ECS, ECR, EFS, VPC, ALB permissions
- [Pulumi CLI](https://www.pulumi.com/docs/install/) + account
- [Bun](https://bun.sh) runtime

### Via GitHub Actions (recommended)

1. Configure GitHub secrets:
   - `AWS_DEPLOY_ROLE_ARN` — IAM role for OIDC federation
   - `PULUMI_ACCESS_TOKEN` — Pulumi Cloud token
   - `PULUMI_CONFIG_PASSPHRASE` — encryption passphrase

2. Go to Actions → "Enterprise Deploy" → Run workflow
   - Action: `deploy`
   - Region: pick one
   - Stack name: e.g., `demo-acme`

3. After deploy, the workflow prints the ALB URL

### Via CLI

```bash
cd deploy/enterprise/pulumi
bun install
pulumi stack init demo-acme
pulumi config set aws:region us-east-1
pulumi up
```

## Tear Down

### GitHub Actions
Run "Enterprise Deploy" with action: `destroy` and the same stack name.

### CLI
```bash
cd deploy/enterprise/pulumi
pulumi destroy -s demo-acme -y
pulumi stack rm demo-acme -y
```

## Configuration

### Enterprise Defaults

| Setting | Value | Notes |
|---------|-------|-------|
| Auth mode | OIDC (Keycloak) | No email OTP |
| Waitlist | Disabled | Direct access |
| Rate limiting | Disabled locally | Enabled on Fargate |

### Keycloak Realm

The realm `thunderbolt` is auto-imported on first boot from `config/keycloak-realm.json`.

- Client: `thunderbolt-app` (secret: `thunderbolt-enterprise-secret`)
- Redirect URIs: wildcard `*` (acceptable for private per-deployment instances)
- Default user: `demo@thunderbolt.so` / `demo`
- Create additional users via Keycloak admin console at `/admin`

### PowerSync

Sync rules in `config/powersync-config.yaml` mirror the main app's rules.
JWT secret must match between backend (`POWERSYNC_JWT_SECRET`) and the `client_auth.jwks`
key in the PowerSync config (base64-encoded).

### Environment Variables

See `.env.example` for all configurable values. Variables hardcoded in
`docker-compose.yml` (auth mode, database URLs, OIDC config, etc.) don't need
to be set in `.env` unless you want to override them.

## Dockerfiles

| File | Base | Purpose |
|------|------|---------|
| `docker/backend.Dockerfile` | oven/bun:latest | Installs deps, runs `bun run src/index.ts` with migration entrypoint |
| `docker/frontend.Dockerfile` | oven/bun → nginx:alpine | Builds Vite SPA, serves via nginx with COEP/COOP headers |
| `docker/postgres.Dockerfile` | postgres:18-alpine | Adds PowerSync replication role init SQL |
| `docker/keycloak.Dockerfile` | keycloak:26.0 | Bakes in realm JSON for auto-import |
| `docker/powersync.Dockerfile` | journeyapps/powersync-service | Bakes in sync rules config |

## Known Limitations

- **Postgres on Fargate**: Not production-grade — use RDS for real deployments
- **No SSL locally**: All local URLs are HTTP. Fargate deployment uses ALB which can terminate TLS
- **Backend compiled binary**: Pino's worker thread transport is incompatible with `bun build --compile`, so the backend runs interpreted in Docker. Performance impact is negligible.
- **MongoDB replica set**: The `mongo-rs-init` container initializes the replica set on first boot. If MongoDB data is wiped, it needs to re-initialize.
