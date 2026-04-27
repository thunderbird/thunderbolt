# Dockerfiles

Shared Docker images used by all deployment targets (docker-compose, k8s, Fargate).

## Images

| Dockerfile | Base | Purpose |
|-----------|------|---------|
| `backend.Dockerfile` | `oven/bun:latest` | Bun API server with Drizzle migration entrypoint |
| `frontend.Dockerfile` | `oven/bun` → `nginx:alpine` | Vite SPA build, served by nginx with COEP/COOP headers |
| `postgres.Dockerfile` | `postgres:18-alpine` | PostgreSQL with PowerSync replication role init |
| `keycloak.Dockerfile` | `keycloak:26.0` | Keycloak with enterprise realm auto-import |
| `powersync.Dockerfile` | `journeyapps/powersync-service` | PowerSync with sync rules config |

## Building

All Dockerfiles use the **repo root** as build context:

```bash
# From repo root:
docker build -f deploy/docker/backend.Dockerfile -t thunderbolt-backend .
docker build -f deploy/docker/frontend.Dockerfile -t thunderbolt-frontend .
docker build -f deploy/docker/postgres.Dockerfile -t thunderbolt-postgres .
docker build -f deploy/docker/keycloak.Dockerfile -t thunderbolt-keycloak .
docker build -f deploy/docker/powersync.Dockerfile -t thunderbolt-powersync .
```

## Frontend Build Args

The frontend Dockerfile accepts build args baked into the static bundle:

| Arg | Default | Purpose |
|-----|---------|---------|
| `VITE_THUNDERBOLT_CLOUD_URL` | `/v1` | Backend API URL (relative, proxied by nginx or ALB) |
| `VITE_AUTH_MODE` | `oidc` | Auth mode (`oidc` for enterprise, omit for consumer) |

## Backend Entrypoint

`backend-entrypoint.sh` runs Drizzle migrations before starting the server:

1. `bun drizzle-kit migrate` — applies pending migrations to Postgres
2. `bun run src/index.ts` — starts the Elysia server

The backend runs **interpreted** (not compiled) because Pino's worker thread transport is incompatible with `bun build --compile`.

## Files

```
docker/
  backend.Dockerfile
  backend-entrypoint.sh
  frontend.Dockerfile
  postgres.Dockerfile
  keycloak.Dockerfile
  powersync.Dockerfile
  postgres-init/
    01-powersync.sql      # Creates replication role, publication, and powersync_storage DB for PowerSync
```
