# Thunderbolt Deployment

> ⚠️ **Under active development — not production ready.** Thunderbolt is currently undergoing a security audit and preparing for enterprise production readiness. These deployment paths are provided for evaluation and early testing. Do not use in production environments.

Self-hosted Thunderbolt with OIDC authentication via Keycloak. Two deployment paths: Docker Compose for simplicity, Kubernetes for enterprise environments.

## Structure

```
deploy/
  docker/              # Dockerfiles (shared by all targets)
  config/              # Shared config (nginx, PowerSync, Keycloak realm)
  pulumi/              # Infrastructure as Code (AWS Fargate or EKS)
  k8s/                 # Kubernetes manifests + up.sh/down.sh scripts
  docker-compose.yml   # Local Docker Compose setup
  .env.example         # Environment variables

powersync-service/
  init-db/             # Postgres init SQL (referenced by deploy, not duplicated)
  config/              # Dev PowerSync config
```

## Choose Your Path

| Path | Best for | Docs |
|------|----------|------|
| **Docker Compose** | Local dev, demos, quick spin-up | [Docker Compose guide](docker-compose.yml) + this README |
| **Kubernetes** | Enterprise clients, production, teams with k8s expertise | [k8s/README.md](k8s/README.md) |
| **Pulumi (AWS)** | Cloud deployment to Fargate or EKS | [pulumi/](pulumi/) |

## Docker Compose (Quickest)

```bash
cd deploy
cp .env.example .env
docker compose up --build
```

| Service | URL | Credentials |
|---------|-----|-------------|
| App | http://localhost:3000 | (via Keycloak SSO) |
| Keycloak admin | http://localhost:8180 | admin / admin |
| Demo user | (Keycloak login) | demo@thunderbolt.io / demo |

```bash
docker compose down        # stop, keep data
docker compose down -v     # stop + wipe data
```

## Containers

All deployment paths use the same Docker images:

| Service | Dockerfile | Purpose |
|---------|-----------|---------|
| Frontend | `docker/frontend.Dockerfile` | nginx serving SPA + COEP/COOP headers |
| Backend | `docker/backend.Dockerfile` | Bun API server with auto-migrations |
| PostgreSQL | `docker/postgres.Dockerfile` | Database with WAL logical replication (init SQL from `powersync-service/init-db/`) |
| Keycloak | `docker/keycloak.Dockerfile` | OIDC identity provider with realm import |
| PowerSync | `docker/powersync.Dockerfile` | Real-time sync service |
| MongoDB | `mongo:7.0` (official) | PowerSync storage backend |

## Configuration

### Enterprise Defaults

| Setting | Value |
|---------|-------|
| Auth mode | OIDC (Keycloak) |
| Waitlist | Disabled |
| Frontend | `VITE_AUTH_MODE=oidc`, `VITE_THUNDERBOLT_CLOUD_URL=/v1` |

### Environment Variables

See [.env.example](.env.example). Variables hardcoded in `docker-compose.yml` (auth mode, database URLs, OIDC config) don't need to be set unless overriding.

### Keycloak

Realm `thunderbolt` auto-imports from `config/keycloak-realm.json` on first boot.
- Client: `thunderbolt-app`
- Default user: demo@thunderbolt.io / demo
- Admin console: `/admin` (admin / admin)

### PowerSync

Sync rules in `config/powersync-config.yaml`. JWT secret must match between backend and PowerSync config.
