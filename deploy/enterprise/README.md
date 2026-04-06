# Thunderbolt Enterprise Deployment

Self-hosted Thunderbolt on AWS ECS Fargate with OIDC authentication via Keycloak.

## Architecture

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

## Containers

| Service | Image | Port | Purpose |
|---------|-------|------|---------|
| Frontend | Custom (nginx) | 80 | Static SPA + COEP/COOP headers |
| Backend | Custom (Bun binary) | 8000 | API server |
| PostgreSQL | postgres:18-alpine | 5432 | Primary database (WAL logical) |
| MongoDB | mongo:7.0 | 27017 | PowerSync storage backend |
| PowerSync | journeyapps/powersync-service | 8080 | Real-time sync |
| Keycloak | quay.io/keycloak/keycloak:26.0 | 8080 | OIDC identity provider |

## Local Testing

```bash
cd deploy/enterprise
cp .env.example .env
# Edit .env with any API keys needed

docker compose up --build
```

- **App:** http://localhost:3000
- **Keycloak admin:** http://localhost:8180 (admin / admin)
- **Demo login:** demo@thunderbolt.so / demo

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
| Rate limiting | Enabled | Hardcoded per-tier limits |

### Keycloak Realm

The realm `thunderbolt` is imported on first boot from `config/keycloak-realm.json`.
- Client: `thunderbolt-app`
- Redirect URIs: wildcard (private instance)
- Create users via Keycloak admin console

### PowerSync

Sync rules in `config/powersync-config.yaml` mirror the main app's rules.
JWT secret must match between backend (`POWERSYNC_JWT_SECRET`) and PowerSync config.
