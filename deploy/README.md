# Thunderbolt Enterprise Deployment

Self-hosted Thunderbolt with OIDC authentication via Keycloak. Three deployment paths: Docker Compose for local development, Helm chart for Kubernetes, and Pulumi for AWS (Fargate or EKS).

## Table of Contents

- [Architecture](#architecture)
- [Services](#services)
- [Directory Structure](#directory-structure)
- [1. Docker Compose (Local Dev)](#1-docker-compose-local-dev)
- [2. Kubernetes with Helm (Local or On-Prem)](#2-kubernetes-with-helm-local-or-on-prem)
- [3. AWS with Pulumi](#3-aws-with-pulumi)
- [4. GitHub Actions CI/CD](#4-github-actions-cicd)
- [Configuration Reference](#configuration-reference)
- [Troubleshooting](#troubleshooting)

---

## Architecture

All deployment paths run the same six services with path-based routing:

```
                        Ingress / ALB / nginx proxy
                        ┌─────────────────────────────┐
                        │  /v1/*        -> backend     │
                        │  /auth/*      -> keycloak    │
                        │  /realms/*    -> keycloak    │
                        │  /powersync/* -> powersync   │
                        │  /*           -> frontend    │
                        └─────────────────────────────┘

  ┌──────────┐    ┌──────────┐    ┌──────────┐
  │ frontend │    │ backend  │    │ keycloak │
  │ (nginx)  │    │ (bun)    │    │ (OIDC)   │
  └──────────┘    └────┬─────┘    └──────────┘
                       │
              ┌────────┼────────┐
              v                 v
        ┌──────────┐     ┌───────────┐
        │ postgres │     │ powersync │
        │ (WAL)    │◄────┤ (sync)    │
        └──────────┘     └─────┬─────┘
                               │
                          ┌────v─────┐
                          │ mongodb  │
                          │ (rs0)    │
                          └──────────┘
```

## Services

All deployment paths use the same Docker images:

| Service | Image | Purpose | Port |
|---------|-------|---------|------|
| **Frontend** | `docker/frontend.Dockerfile` | Vite SPA served by nginx with COEP/COOP headers for PowerSync WASM | 80 |
| **Backend** | `docker/backend.Dockerfile` | Bun + Elysia API server with auto-migrations on startup | 8000 |
| **PostgreSQL** | `docker/postgres.Dockerfile` | Database with WAL logical replication for PowerSync | 5432 |
| **Keycloak** | `docker/keycloak.Dockerfile` | OIDC identity provider with pre-configured realm | 8080 |
| **PowerSync** | `docker/powersync.Dockerfile` | Real-time sync between Postgres and client devices | 8080 |
| **MongoDB** | `mongo:7.0` (official) | PowerSync storage backend (replica set) | 27017 |

### Data Flow

1. **Frontend** serves the SPA and proxies API calls to the backend
2. **Backend** authenticates users via OIDC (Keycloak), reads/writes to Postgres, and issues PowerSync JWTs
3. **PowerSync** replicates Postgres changes to clients via logical replication, stores sync state in MongoDB
4. **MongoDB** runs as a single-node replica set (required by PowerSync)

## Directory Structure

```
deploy/
  docker-compose.yml        # Local dev setup
  docker/                   # Dockerfiles (shared by all targets)
    backend.Dockerfile
    frontend.Dockerfile
    postgres.Dockerfile
    keycloak.Dockerfile
    powersync.Dockerfile
    backend-entrypoint.sh   # Waits for Postgres, runs migrations, starts server
    postgres-init/          # SQL to create PowerSync replication role
  config/                   # Shared config files
    nginx.conf              # Frontend nginx with COEP/COOP headers
    powersync-config.yaml   # Sync rules + replication config
    keycloak-realm.json     # Thunderbolt realm + demo user
  k8s/                      # Helm chart
    Chart.yaml
    values.yaml
    templates/
  pulumi/                   # AWS infrastructure as code
    index.ts                # Entry point (branches on platform config)
    src/
      vpc.ts                # VPC, subnets, NAT, security groups
      eks.ts                # EKS cluster + Helm chart deploy
      cluster.ts            # ECS cluster (Fargate)
      services.ts           # Fargate task definitions
      alb.ts                # Application Load Balancer
      storage.ts            # EFS persistent storage
      discovery.ts          # Cloud Map service discovery

.github/workflows/
  enterprise-publish.yml    # Build + push Docker images to GHCR
  enterprise-deploy.yml     # Deploy to AWS via Pulumi
  enterprise-nightly.yml    # Nightly publish + deploy to demo
```

---

## 1. Docker Compose (Local Dev)

The fastest way to run the full stack locally.

### Prerequisites

- Docker Desktop (or Docker Engine + Compose)

### Quick Start

```bash
cd deploy
docker compose up --build
```

First boot takes a few minutes as images build and Keycloak initializes.

### Access

| Service | URL | Credentials |
|---------|-----|-------------|
| App | http://localhost:3000 | Sign in via Keycloak |
| Keycloak Admin | http://localhost:8180/admin | admin / admin |
| Demo User | (Keycloak login) | demo@thunderbolt.so / demo |
| Postgres | localhost:5433 | postgres / postgres |
| PowerSync | http://localhost:8080 | |

### Customizing Ports

Override any port via environment variables:

```bash
FRONTEND_PORT=4000 KEYCLOAK_PORT=9090 docker compose up --build
```

### Teardown

```bash
docker compose down          # Stop containers, keep data
docker compose down -v       # Stop containers + delete volumes (full reset)
```

### How It Works

- **Startup order**: Postgres and Keycloak start first (with health checks). Backend waits for both. MongoDB starts with a one-shot `mongo-rs-init` container that initializes the replica set. PowerSync waits for both Postgres and the replica set init.
- **Backend entrypoint**: `docker/backend-entrypoint.sh` polls Postgres until it's ready, runs Drizzle migrations, then starts the server.
- **Keycloak**: Auto-imports `config/keycloak-realm.json` on first boot, creating the `thunderbolt` realm, `thunderbolt-app` OIDC client, and a demo user.
- **PowerSync**: Uses `config/powersync-config.yaml` for sync rules. Connects to Postgres via a dedicated `powersync_role` with replication privileges.

---

## 2. Kubernetes with Helm (Local or On-Prem)

Deploy to any Kubernetes cluster using the Helm chart in `deploy/k8s/`.

### Prerequisites

- A running Kubernetes cluster
- `kubectl` configured to talk to it
- `helm` v3 installed
- An nginx-ingress controller (the chart creates an Ingress resource expecting the `nginx` class)

### Local Cluster Setup

Pick one:

**Docker Desktop** (easiest):
Settings -> Kubernetes -> Enable Kubernetes -> Apply & Restart

**Minikube**:
```bash
brew install minikube
minikube start
```

**kind**:
```bash
brew install kind
kind create cluster --name thunderbolt
```

### Install nginx-ingress

```bash
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm install ingress-nginx ingress-nginx/ingress-nginx \
  --create-namespace -n ingress-nginx \
  --set controller.service.type=LoadBalancer
```

### Build Local Images

If deploying locally (not pulling from a registry):

```bash
# From repo root
docker build -f deploy/docker/frontend.Dockerfile \
  --build-arg VITE_THUNDERBOLT_CLOUD_URL=/v1 \
  --build-arg VITE_AUTH_MODE=oidc \
  -t thunderbolt-frontend .

docker build -f deploy/docker/backend.Dockerfile -t thunderbolt-backend .
docker build -f deploy/docker/postgres.Dockerfile -t thunderbolt-postgres .
docker build -f deploy/docker/keycloak.Dockerfile -t thunderbolt-keycloak .
docker build -f deploy/docker/powersync.Dockerfile -t thunderbolt-powersync .
```

> If using Minikube, run `eval $(minikube docker-env)` first so images are available to the cluster. For kind, use `kind load docker-image <image>`.

### Deploy with Helm

```bash
cd deploy/k8s

# Install with default values (local dev)
helm install thunderbolt . -n thunderbolt --create-namespace

# Or customize values
helm install thunderbolt . -n thunderbolt --create-namespace \
  --set appUrl=http://my-domain.com \
  --set frontend.image.repository=thunderbolt-frontend \
  --set frontend.image.tag=latest \
  --set backend.image.repository=thunderbolt-backend \
  --set backend.image.tag=latest
```

### Watch Startup

```bash
kubectl get pods -n thunderbolt -w
```

Wait for all pods to reach `Running 1/1`. Postgres and MongoDB start first (StatefulSets with PVCs), then the rest follow. The `mongo-rs-init` Job runs as a post-install hook to initialize the MongoDB replica set.

### Access

```bash
# Docker Desktop / Minikube tunnel — app is at http://localhost
minikube tunnel  # if using minikube

# Get ingress IP/hostname
kubectl get ingress -n thunderbolt
```

| Path | Service |
|------|---------|
| `/` | Frontend (SPA) |
| `/v1/*` | Backend API |
| `/realms/*` | Keycloak OIDC |
| `/powersync/*` | PowerSync |

### Upgrade

```bash
helm upgrade thunderbolt . -n thunderbolt
```

### Teardown

```bash
helm uninstall thunderbolt -n thunderbolt
kubectl delete namespace thunderbolt
```

> PersistentVolumeClaims created by StatefulSets are not deleted by `helm uninstall`. To fully reset data: `kubectl delete pvc -n thunderbolt --all`

### Pulling from GHCR (Private Registry)

If using pre-built images from GHCR instead of local builds:

```bash
# Create pull secret
kubectl create secret docker-registry ghcr-pull \
  -n thunderbolt \
  --docker-server=ghcr.io \
  --docker-username=oauth2 \
  --docker-password=<your-github-pat>

# Install with pull secret and GHCR images
helm install thunderbolt . -n thunderbolt --create-namespace \
  --set imagePullSecrets[0].name=ghcr-pull \
  --set frontend.image.repository=ghcr.io/thunderbird/thunderbolt/thunderbolt-frontend \
  --set frontend.image.tag=0.1.85 \
  --set backend.image.repository=ghcr.io/thunderbird/thunderbolt/thunderbolt-backend \
  --set backend.image.tag=0.1.85
  # ... etc for each service
```

### Helm Values Reference

See `deploy/k8s/values.yaml` for all configurable values. Key ones:

| Value | Default | Description |
|-------|---------|-------------|
| `appUrl` | `http://localhost` | Base URL for CORS, auth callbacks, redirects |
| `imagePullSecrets` | `[]` | Registry pull secrets |
| `frontend.replicas` | `1` | Frontend replica count |
| `backend.replicas` | `1` | Backend replica count |
| `postgres.storage` | `5Gi` | Postgres PVC size |
| `mongo.storage` | `5Gi` | MongoDB PVC size |
| `ingress.enabled` | `true` | Create Ingress resource |
| `ingress.className` | `nginx` | Ingress class |
| `ingress.host` | `""` | Set for production (empty = default rule) |

---

## 3. AWS with Pulumi

Deploy to AWS using Pulumi. Supports two platforms from the same project:

| Platform | Infrastructure | Persistence | Best For |
|----------|---------------|-------------|----------|
| **fargate** | ECS Fargate + ALB + Cloud Map | EFS | Serverless, no cluster management |
| **k8s** | EKS + nginx-ingress | EBS (gp3 PVCs) | Teams with Kubernetes expertise |

### Prerequisites

- AWS CLI configured (`aws configure sso` or env vars)
- [Pulumi CLI](https://www.pulumi.com/docs/install/)
- [Bun](https://bun.sh)
- A Pulumi account (free tier works)

### Setup

```bash
cd deploy/pulumi
bun install

# Create a new stack
pulumi stack init <stack-name>    # e.g. "dev", "demo-acme", "staging"

# Configure
pulumi config set aws:region us-east-1
pulumi config set platform fargate         # or k8s
pulumi config set version 0.1.85           # image version tag
pulumi config set --secret ghcrToken <pat> # GitHub PAT for pulling images from GHCR
```

### Deploy

```bash
pulumi up
```

This creates all infrastructure from scratch: VPC, subnets, NAT gateway, security groups, and the platform-specific resources.

**Fargate** creates: ECS cluster, ALB with path-based routing, EFS for database persistence, Cloud Map for service discovery, and 6 Fargate services.

**EKS** creates: EKS cluster (2x t3.medium nodes), EBS CSI driver + gp3 StorageClass, Helm chart deployment, and an nginx-ingress controller with an AWS LoadBalancer.

### Get the URL

**Fargate**:
```bash
pulumi stack output url
# -> http://<alb-dns-name>.us-east-1.elb.amazonaws.com
```

**EKS**:
```bash
# Write kubeconfig
pulumi stack output kubeconfig > /tmp/kubeconfig.json
export KUBECONFIG=/tmp/kubeconfig.json

# Get the LoadBalancer hostname
kubectl get svc -n ingress-nginx -o jsonpath="{.items[0].status.loadBalancer.ingress[0].hostname}"
```

### Custom Secrets

Override default credentials via Pulumi config:

```bash
pulumi config set --secret postgresPassword <password>
pulumi config set --secret keycloakAdminPassword <password>
pulumi config set --secret oidcClientSecret <secret>
pulumi config set --secret powersyncJwtSecret <secret>
pulumi config set --secret betterAuthSecret <secret>
```

If not set, sensible defaults are used (suitable for dev/demo, not production).

### Destroy

```bash
pulumi destroy -y
pulumi stack rm <stack-name> -y   # remove stack metadata
```

### Pulumi Project Structure

```
pulumi/
  index.ts              # Entry point — reads config, branches on platform
  Pulumi.yaml           # Project metadata
  Pulumi.<stack>.yaml   # Per-stack config (created by pulumi config)
  src/
    vpc.ts              # VPC (10.0.0.0/16), 2 AZs, public + private subnets, NAT
    # -- Fargate --
    cluster.ts          # ECS cluster + CloudWatch log group
    services.ts         # 6 Fargate task definitions + ECS services
    alb.ts              # ALB + target groups + path-based listener rules
    storage.ts          # EFS + access points (postgres uid:70, mongo uid:999)
    discovery.ts        # Cloud Map private DNS (thunderbolt.local)
    # -- EKS --
    eks.ts              # EKS cluster, EBS CSI driver, Helm chart, nginx-ingress
```

---

## 4. GitHub Actions CI/CD

Three workflows handle the enterprise build and deploy pipeline:

### Enterprise Publish

**File**: `.github/workflows/enterprise-publish.yml`

Builds and pushes all Docker images + the Helm chart to GHCR.

**Triggers**:
- Push to `main` (when `deploy/`, `backend/`, `src/`, or `package.json` change)
- Manual dispatch
- Called by other workflows

**What it does**:
1. Reads version from `package.json`
2. Builds 5 Docker images (frontend, backend, postgres, keycloak, powersync)
3. Tags each with `<version>` and `latest`
4. Packages the Helm chart and pushes to `oci://ghcr.io/<owner>/charts`

### Enterprise Deploy

**File**: `.github/workflows/enterprise-deploy.yml`

Deploys (or destroys) a Pulumi stack on AWS.

**Triggers**:
- Manual dispatch with form inputs
- Called by other workflows

**Inputs**:

| Input | Options | Default | Description |
|-------|---------|---------|-------------|
| `action` | deploy, destroy | (required) | What to do |
| `platform` | fargate, k8s | fargate | Compute platform |
| `region` | us-east-1, us-west-2, eu-west-1 | us-east-1 | AWS region |
| `stack_name` | (string) | (required) | Pulumi stack name (e.g. `demo`) |
| `version` | (string) | package.json | Image version to deploy |

**Required Secrets**:

| Secret | Description |
|--------|-------------|
| `AWS_DEPLOY_ROLE_ARN` | IAM role ARN for OIDC-based AWS auth |
| `PULUMI_ACCESS_TOKEN` | Pulumi Cloud API token |
| `PULUMI_CONFIG_PASSPHRASE` | Encryption passphrase for stack config |
| `GHCR_PAT` | GitHub PAT for pulling private images |

### Enterprise Nightly

**File**: `.github/workflows/enterprise-nightly.yml`

Runs every night at 5:00 UTC (midnight EST). Publishes fresh images and redeploys the `demo` stack on Fargate.

**Triggers**:
- Cron schedule: `0 5 * * *`
- Manual dispatch

**Pipeline**:
1. Calls `enterprise-publish.yml` (build + push images)
2. Calls `enterprise-deploy.yml` (deploy to `demo` stack on Fargate)

---

## Configuration Reference

### Default Credentials

All deployment paths use the same defaults. Override for production.

| Credential | Default | Used By |
|------------|---------|---------|
| Postgres password | `postgres` | Backend, Postgres |
| Keycloak admin | `admin` / `admin` | Keycloak |
| OIDC client secret | `thunderbolt-enterprise-secret` | Backend, Keycloak |
| PowerSync JWT secret | `enterprise-powersync-secret` | Backend, PowerSync |
| Better Auth secret | `enterprise-better-auth-secret` | Backend |
| Demo user | `demo@thunderbolt.so` / `demo` | Keycloak |

### Keycloak

The realm `thunderbolt` is auto-imported from `config/keycloak-realm.json` on first boot:
- OIDC client: `thunderbolt-app` (confidential)
- Demo user: `demo@thunderbolt.so` / `demo`
- Admin console at `/auth/admin` (Docker Compose: port 8180, Kubernetes/AWS: via ingress at `/auth`)

### PowerSync

Sync rules are defined in `config/powersync-config.yaml`. The `user_data` bucket syncs these tables scoped by `user_id`:

settings, chat_threads, chat_messages, tasks, models, mcp_servers, prompts, triggers, modes, model_profiles, devices

The PowerSync JWT secret must match between the backend (`POWERSYNC_JWT_SECRET`) and the PowerSync config.

### Postgres

The init script (`docker/postgres-init/01-powersync.sql`) creates:
- `powersync_role` with `REPLICATION` privileges
- A publication on all tables for logical replication
- PostgreSQL runs with `wal_level=logical` in all deployment paths

---

## Troubleshooting

### Docker Compose

**Backend won't start**: Check that Postgres is healthy (`docker compose logs postgres`). The backend entrypoint polls Postgres and won't start migrations until it's ready.

**PowerSync crashes**: MongoDB replica set must be initialized. The `mongo-rs-init` service handles this automatically, but if it fails: `docker compose exec mongo mongosh --eval 'rs.initiate()'`

### Kubernetes / Helm

**Pods stuck in Pending**: Check PVC status with `kubectl get pvc -n thunderbolt`. If unbound, ensure a default StorageClass exists (`kubectl get sc`). On EKS, the EBS CSI driver must be installed.

**Postgres CrashLoopBackOff**: Check logs with `kubectl logs postgres-0 -n thunderbolt`. If you see "directory exists but is not empty" with `lost+found`, the `PGDATA` env var needs to point to a subdirectory (this is set in the chart).

**PowerSync CrashLoopBackOff with "RSGhost"**: The MongoDB replica set isn't initialized. The Helm post-install hook should handle this, but if it failed:
```bash
kubectl exec -it mongo-0 -n thunderbolt -- mongosh --eval \
  'rs.initiate({_id: "rs0", members: [{_id: 0, host: "mongo-0.mongo:27017"}]})'
```

**Backend CreateContainerConfigError**: Usually a missing Secret. Verify `thunderbolt-secrets` exists: `kubectl get secret thunderbolt-secrets -n thunderbolt`

### AWS / Pulumi

**Helm release timeout**: The default timeout is 900 seconds. On a cold deploy (new cluster + image pulls), services may take longer. Check pod status:
```bash
pulumi stack output kubeconfig > /tmp/kubeconfig.json
export KUBECONFIG=/tmp/kubeconfig.json
kubectl get pods -n thunderbolt
kubectl get events -n thunderbolt --sort-by='.lastTimestamp' | tail -20
```

**EKS PVCs stuck in Pending**: The EBS CSI driver and a default StorageClass are required. Both are provisioned automatically by the Pulumi EKS setup (`createOidcProvider: true` + `aws-ebs-csi-driver` addon + `gp3` StorageClass).

**Fargate service won't start**: Check CloudWatch logs in the AWS console. The log group is named after the stack (e.g., `tb-dev-logs`). Common issues: image pull failures (check GHCR token), EFS mount failures, security group rules.

**AWS credentials expired**: Re-authenticate with `aws configure sso` or refresh your session.
