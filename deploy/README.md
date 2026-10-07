# Thunderbolt Enterprise Deployment

> ⚠️ **Under active development — not production ready.** Thunderbolt is currently undergoing a security audit and preparing for enterprise production readiness. These deployment paths are provided for evaluation and early testing. Do not use in production environments.

Self-hosted Thunderbolt with OIDC or SAML authentication via Keycloak. Three deployment paths: Docker Compose for local development, Helm chart for Kubernetes, and Pulumi for AWS (Fargate or EKS).

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

The stack is six services. Docker Compose runs five of them — the marketing site (the Astro landing page, blog and docs) is only wired into the Helm chart and the Pulumi stacks.

The path-based routing below describes the Kubernetes Ingress (`k8s/templates/ingress.yaml`) and the Fargate ALB (`pulumi/src/alb.ts`). Docker Compose has no shared ingress: each service is published on its own host port and the frontend's nginx proxies `/v1/` only.

```
                        Ingress / ALB
                        ┌──────────────────────────────────────┐
                        │  /v1/*        -> backend             │
                        │  /realms/*    -> keycloak            │
                        │  /resources/* -> keycloak (k8s only) │
                        │  /auth/*      -> keycloak (ALB only) │
                        │  /powersync/* -> powersync           │
                        │  /*           -> frontend            │
                        └──────────────────────────────────────┘

  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌───────────┐
  │ frontend │    │ backend  │    │ keycloak │    │ marketing │
  │ (nginx)  │    │ (bun)    │    │ (OIDC)   │    │ (nginx)   │
  └──────────┘    └────┬─────┘    └──────────┘    └───────────┘
                       │
              ┌────────┼────────┐
              v                 v
        ┌──────────┐     ┌───────────┐
        │ postgres │◄────┤ powersync │
        │ (WAL +   │     │ (sync)    │
        │  buckets)│     └───────────┘
        └──────────┘
```

Path rules are the fallback. When per-service hostnames are configured — the preview stacks do this — host-header rules take precedence and every service, marketing included, gets its own subdomain (`pulumi/src/alb.ts`, `k8s/templates/ingress.yaml`).

## Services

The Helm chart and the Pulumi stacks run the published images built from these Dockerfiles. Docker Compose builds only the frontend and backend from them — Postgres, PowerSync and Keycloak run their upstream images directly with the same config files bind-mounted (`docker-compose.yml`).

| Service        | Image                         | Purpose                                                                                                        | Port |
| -------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------- | ---- |
| **Frontend**   | `docker/frontend.Dockerfile`  | Vite SPA served by nginx with COEP/COOP headers for PowerSync WASM                                             | 8080 |
| **Backend**    | `docker/backend.Dockerfile`   | Bun + Elysia API server with auto-migrations on startup                                                        | 8000 |
| **PostgreSQL** | `docker/postgres.Dockerfile`  | Database with WAL logical replication for PowerSync; hosts both app data and the `powersync_storage` bucket DB | 5432 |
| **Keycloak**   | `docker/keycloak.Dockerfile`  | OIDC identity provider with pre-configured realm                                                               | 8080 |
| **PowerSync**  | `docker/powersync.Dockerfile` | Real-time sync between Postgres and client devices                                                             | 8080 |
| **Marketing**  | `docker/marketing.Dockerfile` | Astro static site (landing page, blog, and the repo's `docs/`) served by nginx; not in Docker Compose          | 8080 |

### Data Flow

1. **Frontend** serves the SPA and proxies API calls to the backend
2. **Backend** authenticates users via OIDC (Keycloak), reads/writes to Postgres, and issues PowerSync JWTs
3. **PowerSync** replicates Postgres changes to clients via logical replication; stores bucket state in the `powersync_storage` database on the same Postgres instance

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
    marketing.Dockerfile
    backend-entrypoint.sh   # Waits for Postgres, runs migrations, starts server
    postgres-init/          # 01-powersync.sh — replication role, publication, storage DB
  config/                   # Shared config files
    nginx.conf.template     # Frontend nginx with COEP/COOP headers; ${THUNDERBOLT_BACKEND_HOST}/${THUNDERBOLT_BACKEND_PORT} substituted at container start
    security-headers.conf   # Shared nginx security-header snippet, included by nginx.conf.template
    marketing-nginx.conf    # Marketing/docs site nginx
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
  images-publish.yml         # Build + push Docker images to GHCR
  stack-deploy.yml           # Deploy to AWS via Pulumi
  nightly-images.yml         # Nightly rebuild + publish of main images to GHCR
  preview-deploy.yml         # Per-PR ephemeral preview stack
  preview-destroy.yml        # Tears the preview stack down when the PR closes
  preview-cleanup.yml        # Hourly orphan sweep
  previews-shared-deploy.yml # Long-lived infrastructure the previews share
```

---

## 1. Docker Compose (Local Dev)

The fastest way to run the full stack locally.

### Prerequisites

- Docker Desktop (or Docker Engine + Compose)

### Quick Start

```bash
cd deploy
cp .env.example .env
# Set BETTER_AUTH_SECRET in .env — generate one with: openssl rand -base64 32
docker compose up --build
```

The `.env` file is not optional: the backend service declares `env_file: .env`, and `BETTER_AUTH_SECRET` has no default (`docker-compose.yml`), so compose fails without it. `.env.example` also carries the published host ports, which is why they differ from the fallbacks baked into `docker-compose.yml`.

First boot takes a few minutes as images build and Keycloak initializes.

### Access

| Service        | URL                         | Credentials                |
| -------------- | --------------------------- | -------------------------- |
| App            | http://localhost:3000       | Sign in via Keycloak       |
| Keycloak Admin | http://localhost:8180/admin | admin / admin              |
| Demo User      | (Keycloak login)            | demo@thunderbolt.io / demo |
| Postgres       | localhost:5434              | postgres / postgres        |
| PowerSync      | http://localhost:8081       |                            |

### Customizing Ports

Ports come from `deploy/.env` (`FRONTEND_PORT`, `BACKEND_PORT`, `KEYCLOAK_PORT`, `POSTGRES_PORT`, `POWERSYNC_PORT`). Override them there, or inline:

```bash
FRONTEND_PORT=4000 KEYCLOAK_PORT=9090 docker compose up --build
```

### Teardown

```bash
docker compose down          # Stop containers, keep data
docker compose down -v       # Stop containers + delete volumes (full reset)
```

### How It Works

- **Startup order**: Postgres and Keycloak start first (with health checks). Backend waits for both. PowerSync waits for Postgres (it uses the `powersync_storage` database on the same instance for bucket storage).
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
Settings → Kubernetes → Enable Kubernetes → Apply & Restart.

**kind** (recommended for clean isolation):

```bash
brew install kind

cat > /tmp/kind-thunderbolt.yaml <<'EOF'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    kubeadmConfigPatches:
      - |
        kind: InitConfiguration
        nodeRegistration:
          kubeletExtraArgs:
            node-labels: "ingress-ready=true"
    extraPortMappings:
      - containerPort: 80
        hostPort: 80
        protocol: TCP
      - containerPort: 443
        hostPort: 443
        protocol: TCP
EOF

kind create cluster --name thunderbolt --config /tmp/kind-thunderbolt.yaml
```

The `extraPortMappings` and `ingress-ready` label are required for the chart's
ingress to be reachable at `http://localhost`. A bare `kind create cluster`
boots a cluster with no host port mappings, and the ingress install in the next
step will succeed but be unreachable.

**Minikube**:

```bash
brew install minikube
minikube start
```

### Install nginx-ingress

For **kind**, use the kind-flavored manifest (binds to the labeled node):

```bash
kubectl apply -f https://kind.sigs.k8s.io/examples/ingress/deploy-ingress-nginx.yaml

kubectl wait --namespace ingress-nginx \
  --for=condition=ready pod \
  --selector=app.kubernetes.io/component=controller \
  --timeout=120s
```

For **Docker Desktop / Minikube**, use the standard chart:

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
  --build-arg VITE_AUTH_MODE=sso \
  -t thunderbolt-frontend .

docker build -f deploy/docker/backend.Dockerfile -t thunderbolt-backend .
docker build -f deploy/docker/postgres.Dockerfile -t thunderbolt-postgres .
docker build -f deploy/docker/keycloak.Dockerfile -t thunderbolt-keycloak .
docker build -f deploy/docker/powersync.Dockerfile -t thunderbolt-powersync .
docker build -f deploy/docker/marketing.Dockerfile -t thunderbolt-marketing .
```

The chart renders the marketing Deployment unconditionally, so all six images are needed for a fully local install.

> If using Minikube, run `eval $(minikube docker-env)` first so images are available to the cluster. For kind, use `kind load docker-image <image>`.

### Deploy with Helm

The chart requires `backend.betterAuthSecretBase64`. Generate one and install:

```bash
cd deploy/k8s

BETTER_AUTH_SECRET=$(openssl rand -base64 32 | tr -d '\n' | base64)

helm install thunderbolt . -n thunderbolt --create-namespace \
  --set backend.betterAuthSecretBase64="$BETTER_AUTH_SECRET"
```

Default image repos point at the public images at
`ghcr.io/thunderbird/thunderbolt/*` — no pull secret needed for a local install.

To customize for a production deploy:

```bash
helm install thunderbolt . -n thunderbolt --create-namespace \
  --set backend.betterAuthSecretBase64="$BETTER_AUTH_SECRET" \
  --set appUrl=https://thunderbolt.your-domain.com \
  --set ingress.host=thunderbolt.your-domain.com \
  --set frontend.image.tag=0.1.95 \
  --set backend.image.tag=0.1.95
```

### Watch Startup

```bash
kubectl get pods -n thunderbolt -w
```

Wait for all pods to reach `Running 1/1`. Postgres starts first (StatefulSet with a PVC), then the rest follow.

### Access

```bash
# Docker Desktop / Minikube tunnel — app is at http://localhost
minikube tunnel  # if using minikube

# Get ingress IP/hostname
kubectl get ingress -n thunderbolt
```

| Path           | Service        |
| -------------- | -------------- |
| `/`            | Frontend (SPA) |
| `/v1/*`        | Backend API    |
| `/realms/*`    | Keycloak OIDC  |
| `/powersync/*` | PowerSync      |

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

| Value               | Default            | Description                                  |
| ------------------- | ------------------ | -------------------------------------------- |
| `appUrl`            | `http://localhost` | Base URL for CORS, auth callbacks, redirects |
| `imagePullSecrets`  | `[]`               | Registry pull secrets                        |
| `frontend.replicas` | `1`                | Frontend replica count                       |
| `backend.replicas`  | `1`                | Backend replica count                        |
| `postgres.storage`  | `5Gi`              | Postgres PVC size                            |
| `ingress.enabled`   | `true`             | Create Ingress resource                      |
| `ingress.className` | `nginx`            | Ingress class                                |
| `ingress.host`      | `""`               | Set for production (empty = default rule)    |

### Known caveats

- **TLS to RDS Postgres.** RDS rejects plaintext connections by default, so when pointing any Postgres URI at RDS (or another TLS-terminating Postgres) set `postgres.sslmode: require` in `values.yaml`. The value flows into both the backend's `DATABASE_URL` (as `?sslmode=...`) and PowerSync's `replication`/`storage` config. A wrong `sslmode` produces a different failure shape than the PowerSync caveat below — operators hitting RDS issues should check this setting first.

- **PowerSync storage on RDS Postgres 17.** PowerSync 1.20.5 fails opaquely when its internal `storage` connection points at an RDS-managed Postgres 17 instance. Observed signature: the service hangs partway through `PostgresLockManager.init` and never reaches the "Power up" log line; the underlying `pgwire` 0.8.1 client swallows the actual server-side error, so the only visible symptom is the missing readiness probe success. The same bootstrap DDL succeeds via `psql` against the same database, so it is not a privilege issue. Scope confirmed on PowerSync 1.20.5; PowerSync 1.15/1.16 were not retested by us and may or may not be affected. This caveat applies to the `storage` connection only — the app's primary Postgres connection (read/write + logical replication, pointed at any reachable Postgres) is unaffected. If you hit this and the `postgres.sslmode` setting above did not resolve it, please open an issue against [powersync-ja/powersync-service](https://github.com/powersync-ja/powersync-service/issues) with your RDS PG major version and PowerSync version so the report is searchable. Workaround: keep PowerSync's storage off RDS (use the in-cluster Postgres StatefulSet, an unmanaged Postgres elsewhere, or MongoDB storage).

---

## 3. AWS with Pulumi

Deploy to AWS using Pulumi. Supports two platforms from the same project:

| Platform    | Infrastructure                | Persistence    | Best For                          |
| ----------- | ----------------------------- | -------------- | --------------------------------- |
| **fargate** | ECS Fargate + ALB + Cloud Map | EFS            | Serverless, no cluster management |
| **k8s**     | EKS + nginx-ingress           | EBS (gp3 PVCs) | Teams with Kubernetes expertise   |

### Prerequisites

- AWS CLI configured (`aws configure sso` or env vars)
- [Pulumi CLI](https://www.pulumi.com/docs/install/)
- [Bun](https://bun.sh)
- A Pulumi account (free tier works)

### Authenticate with Pulumi

```bash
pulumi login
```

This opens a browser to sign in with GitHub, Google, or your org's SSO. It's a one-time setup — credentials are cached locally. (CI uses the `PULUMI_ACCESS_TOKEN` secret instead.)

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

All secrets have sensible defaults that work out of the box for dev/demo stacks. For production, override them via Pulumi config — this is a one-time setup per stack:

```bash
pulumi config set --secret postgresPassword <password> -s <stack-name>
pulumi config set --secret keycloakAdminPassword <password> -s <stack-name>
pulumi config set --secret oidcClientSecret <secret> -s <stack-name>
pulumi config set --secret powersyncJwtSecret <secret> -s <stack-name>
pulumi config set --secret betterAuthSecret <secret> -s <stack-name>
pulumi config set --secret powersyncDbPassword <password> -s <stack-name>
```

Secrets are stored encrypted in the Pulumi stack config (`Pulumi.<stack>.yaml` in Pulumi Cloud). Once set, every subsequent `pulumi up` — whether from the CLI or GitHub Actions — picks them up automatically. No need to configure them as GitHub secrets.

| Secret                  | Default                                               | Description                                            |
| ----------------------- | ----------------------------------------------------- | ------------------------------------------------------ |
| `postgresPassword`      | `postgres`                                            | PostgreSQL admin password                              |
| `keycloakAdminPassword` | `admin`                                               | Keycloak admin console password                        |
| `oidcClientSecret`      | `thunderbolt-enterprise-secret`                       | OIDC client secret shared between Backend and Keycloak |
| `powersyncJwtSecret`    | `enterprise-thunderbolt-powersync-jwt-default-secret` | JWT secret shared between Backend and PowerSync        |
| `betterAuthSecret`      | `enterprise-thunderbolt-better-auth-default-secret`   | Better Auth session secret                             |
| `powersyncDbPassword`   | `myhighlyrandompassword`                              | PowerSync replication role password                    |

The PowerSync default is long on purpose: the backend refuses to start with a `powersyncJwtSecret` shorter than 32 characters whenever `POWERSYNC_URL` is set (`backend/src/config/settings.ts`). Any replacement must clear the same bar.

Preview stacks are the exception to "defaults work out of the box". Because `preview-*` stacks are publicly reachable and these defaults are visible in this repo, `deploy/pulumi/index.ts` generates a random per-stack value for `postgresPassword`, `powersyncJwtSecret`, `betterAuthSecret` and `powersyncDbPassword` when no explicit override is configured.

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
    storage.ts          # EFS + postgres access point (uid:70)
    discovery.ts        # Cloud Map private DNS (thunderbolt.local)
    dns.ts              # Cloudflare CNAMEs for the configured hostnames
    # -- Shared-stack previews (see SHARED.md) --
    shared.ts           # previews-shared: VPC, EFS, cluster, ALB, postgres/keycloak/powersync
    per-pr-stack.ts     # preview-pr-*: backend/frontend/marketing + per-PR routing, Keycloak client, secrets
    # -- EKS --
    eks.ts              # EKS cluster, EBS CSI driver, Helm chart, nginx-ingress
```

---

## 4. GitHub Actions CI/CD

Seven workflows make up the pipeline: three for the enterprise path (images publish, stack deploy, nightly rebuild) and four for the ephemeral per-PR preview stacks.

### Images Publish

**File**: `.github/workflows/images-publish.yml`

Builds and pushes all Docker images + the Helm chart to GHCR.

**Triggers**:

- Push to `main` (when `deploy/**`, `backend/**`, `src/**`, `shared/defaults/models.ts`, `shared/inference-usage.ts`, or `package.json` change)
- Manual dispatch
- Called by other workflows

**What it does**:

1. Reads version from `package.json`
2. Builds 6 Docker images (frontend, backend, postgres, keycloak, powersync, marketing)
3. Tags each with `<version>` and `latest`
4. Packages the Helm chart and pushes to `oci://ghcr.io/<owner>/charts`

A caller can pass `tag_override` to tag the images with something other than the `package.json` version — the preview deploys use `pr-<n>-<sha>`. Setting it also skips the `:latest` tag and the Helm chart push, so a preview build never moves the pointers a real release owns.

### Stack Deploy

**File**: `.github/workflows/stack-deploy.yml`

Deploys (or destroys) a Pulumi stack on AWS.

**Triggers**:

- Manual dispatch with form inputs
- Called by other workflows

**Setting up a new stack for CI**: The workflow uses Pulumi stacks, which are configured once from the CLI and then reused by every workflow run. To deploy a new environment:

```bash
cd deploy/pulumi
pulumi stack init prod-acme
pulumi config set aws:region us-east-1 -s prod-acme
pulumi config set platform fargate -s prod-acme
pulumi config set version 0.1.85 -s prod-acme
pulumi config set --secret ghcrToken <github-pat> -s prod-acme

# Optional: override default credentials for production
pulumi config set --secret postgresPassword <password> -s prod-acme
# ... (see Custom Secrets above)
```

After this one-time setup, trigger the workflow with `stack_name: prod-acme` and it just works.

**Inputs**: the manual-dispatch form exposes the first five. The rest are `workflow_call`-only and exist for the preview workflows.

| Input                           | Options                         | Default      | Description                                                                       |
| ------------------------------- | ------------------------------- | ------------ | --------------------------------------------------------------------------------- |
| `action`                        | deploy, destroy                 | (required)   | What to do                                                                        |
| `platform`                      | fargate, k8s                    | fargate      | Compute platform                                                                  |
| `region`                        | us-east-1, us-west-2, eu-west-1 | us-east-1    | AWS region                                                                        |
| `stack_name`                    | (string)                        | (required)   | Pulumi stack name (e.g. `demo`)                                                   |
| `version`                       | (string)                        | package.json | Image version to deploy                                                           |
| `marketing_hostname`            | (string)                        | —            | Hostname for the marketing site                                                   |
| `app_hostname`                  | (string)                        | —            | Hostname for the app frontend                                                     |
| `api_hostname`                  | (string)                        | —            | Hostname for the backend API                                                      |
| `auth_hostname`                 | (string)                        | —            | Hostname for Keycloak                                                             |
| `powersync_hostname`            | (string)                        | —            | Hostname for PowerSync                                                            |
| `cloudflare_zone_id`            | (string)                        | —            | Required when any hostname is set                                                 |
| `thunderbolt_inference_url`     | (string)                        | —            | Inference gateway URL (non-secret, passed as plain config)                        |
| `confidential_api_keys_enabled` | (boolean)                       | false        | Let a personal access token reach the confidential (Tinfoil) routes on this stack |
| `shared_stack_name`             | (string)                        | —            | Switches to shared-stack mode — see below                                         |

Hostnames add host-header rules that take precedence over the path-based fallback. `cloudflare_zone_id` is mandatory alongside them because the stack creates the DNS records itself — `deploy/pulumi/index.ts` fails fast if subdomain routing is configured without a zone ID and API token.

`shared_stack_name` switches a per-PR deploy into shared-stack mode (THU-495): it deploys backend, frontend and marketing only, and reads the VPC, ALB, Postgres, Keycloak and PowerSync from the named stack via a Pulumi `StackReference`. Leave it empty for a standalone deploy. See `deploy/pulumi/SHARED.md`.

**Secrets**: all are declared optional. An enterprise deploy needs the first three; the rest are for preview DNS and for provisioning provider keys into the stack.

| Secret                          | Description                                              |
| ------------------------------- | -------------------------------------------------------- |
| `AWS_DEPLOY_ROLE_ARN`           | IAM role ARN for OIDC-based AWS auth                     |
| `PULUMI_ACCESS_TOKEN`           | Pulumi Cloud API token                                   |
| `GHCR_PAT`                      | GitHub PAT for pulling private images                    |
| `CLOUDFLARE_API_TOKEN`          | Cloudflare API token, for the preview DNS records        |
| `ANTHROPIC_API_KEY`             | Anthropic provider key                                   |
| `FIREWORKS_API_KEY`             | Fireworks provider key                                   |
| `THUNDERBOLT_INFERENCE_API_KEY` | Inference gateway key                                    |
| `TINFOIL_API_KEY`               | Tinfoil provider key                                     |
| `TINFOIL_ENCLAVE_URL`           | Tinfoil enclave endpoint                                 |
| `EXA_API_KEY`                   | Exa search key — resolved from the `preview` environment |

The deploy job runs under GitHub's `preview` environment so that env-scoped secret (`EXA_API_KEY`) resolves. No reviewers are configured on it, so enterprise dispatches are not gated. There is no `PULUMI_CONFIG_PASSPHRASE`: the workflow authenticates with `PULUMI_ACCESS_TOKEN` alone, and `Pulumi.yaml` declares no `secretsprovider`, so stack config is encrypted by Pulumi Cloud's managed key.

### Preview Environments

Four workflows give every pull request a disposable stack on Fargate, reachable at five Cloudflare subdomains under `preview.thunderbolt.io` (marketing, app, api, auth, powersync).

**`preview-deploy.yml`** builds the PR's images through `images-publish.yml` with a `pr-<n>-<sha>` tag, then calls `stack-deploy.yml` with `stack_name: preview-pr-<n>` and `shared_stack_name: previews-shared`, and leaves a sticky comment carrying the URL. Same-repo PRs deploy on `pull_request` with no human gate. Fork PRs go through `pull_request_target` behind the `fork-preview-approval` environment, so a maintainer approves every push: under that trigger the workflow file and the Pulumi program are both read from `main`, meaning a fork can change the images but never the infrastructure code that deploys them.

**`preview-destroy.yml`** tears the stack down on `pull_request_target: closed`. It uses `pull_request_target` rather than `pull_request` so credentials are available when a fork PR closes; no approval gate is needed because nothing from the fork is checked out.

**`preview-cleanup.yml`** is the hourly safety net for stacks the destroy path missed — a failed teardown, a PR closed out of band, or an open PR idle past `max_age_days` (default 3). The `preview:persist` label opts a PR's stack out, and `workflow_dispatch` takes a `dry_run` input that lists what would go without destroying it.

**`previews-shared-deploy.yml`** owns `previews-shared`, the long-lived stack holding the VPC, EFS, ECS cluster, Cloud Map namespace, ALB, and the shared Postgres, Keycloak and PowerSync services. Per-PR stacks read it through a Pulumi `StackReference` and so only pay for backend, frontend and marketing. It runs on manual dispatch and weekly (Mondays 07:00 UTC) to catch drift. See `deploy/pulumi/SHARED.md`.

### Nightly Images

**File**: `.github/workflows/nightly-images.yml`

Nightly at 5:00 UTC (midnight EST), rebuilds and publishes the `main`-branch images to GHCR (version tag, `:latest`, and Helm chart) by calling `images-publish.yml`. Since `images-publish.yml` also runs on every push to `main` touching the paths listed above, this scheduled run only adds value on quiet days — refreshing images when the source hasn't changed (e.g. upstream base-image / security updates).

**Triggers**:

- Cron schedule: `0 5 * * *`
- Manual dispatch

---

## Configuration Reference

### Default Credentials

All deployment paths use the same defaults, with one exception noted below. Override for production.

| Credential           | Default                                                           | Used By            |
| -------------------- | ----------------------------------------------------------------- | ------------------ |
| Postgres password    | `postgres`                                                        | Backend, Postgres  |
| Keycloak admin       | `admin` / `admin`                                                 | Keycloak           |
| OIDC client secret   | `thunderbolt-enterprise-secret`                                   | Backend, Keycloak  |
| PowerSync JWT secret | `enterprise-thunderbolt-powersync-jwt-default-secret`             | Backend, PowerSync |
| Better Auth secret   | `enterprise-thunderbolt-better-auth-default-secret` (Pulumi only) | Backend            |
| Demo user            | `demo@thunderbolt.io` / `demo`                                    | Keycloak           |

The Better Auth secret is the exception: only the Pulumi stacks carry a default. Docker Compose requires `BETTER_AUTH_SECRET` in `deploy/.env` and the Helm chart requires `backend.betterAuthSecretBase64` — neither has a fallback, by design, because that secret signs session cookies and bearer tokens.

The PowerSync JWT secret is long rather than friendly because the backend rejects anything under 32 characters once `POWERSYNC_URL` is set (`backend/src/config/settings.ts`).

### Keycloak

The realm `thunderbolt` is auto-imported from `config/keycloak-realm.json` on first boot:

- OIDC client: `thunderbolt-app` (confidential)
- Demo user: `demo@thunderbolt.io` / `demo`
- Admin console at `/admin` on the Keycloak service itself — the images set no `KC_HTTP_RELATIVE_PATH`, so Keycloak serves from the root. Under Docker Compose that is http://localhost:8180/admin. On Kubernetes and Fargate it is reachable through the `auth` hostname when one is configured; the path-based fallback routes only `/realms` (plus `/resources` on Kubernetes and `/auth/*` on the ALB), so without an `auth` hostname use `kubectl port-forward` instead.

### PowerSync

Sync rules live in `config/powersync-config.yaml`, and the same rules are inlined in the Helm chart's ConfigMap (`k8s/templates/configmaps.yaml`). Both must be edited together — a table added to one and not the other syncs on one deployment path and silently not on the other.

Two buckets split the tables by how soon the client needs them. Both are parameterised on `request.user_id()`, so every row is scoped to its owner.

| Bucket            | Priority | Tables                                                            |
| ----------------- | -------- | ----------------------------------------------------------------- |
| `user_essentials` | 1        | settings, models, model_profiles, devices, chat_threads           |
| `user_data`       | 2        | chat_messages, tasks, prompts, skills, triggers, agents, projects |

Priority 1 completes first, so a reconnecting device gets its settings, model list and thread index before the message bodies start arriving.

The PowerSync JWT secret must match between the backend (`POWERSYNC_JWT_SECRET`) and the PowerSync config, where it is supplied base64-encoded as the JWK `k` value. The env var carrying it differs by path: `PS_JWT_KEY_BASE64` in `config/powersync-config.yaml` (Docker Compose and Fargate), `POWERSYNC_JWT_SECRET_B64` in the Helm ConfigMap, which reads it from the `powersync-jwt-secret-b64` entry of the `thunderbolt-secrets` Secret.

### Postgres

The init script (`docker/postgres-init/01-powersync.sh`) runs on first Postgres init only and creates:

- The `powersync` schema
- `powersync_role` with `REPLICATION` and `BYPASSRLS`, granted `SELECT` on that schema
- The `powersync` publication for logical replication
- The `powersync_storage` database PowerSync uses for bucket storage

It is a shell script rather than plain SQL so the role password can come from the environment — it requires `POWERSYNC_DB_PASSWORD` and exits if it is unset, which is how preview stacks randomise it per stack. PostgreSQL runs with `wal_level=logical` on all three deployment paths.

---

## Troubleshooting

### Docker Compose

**Backend won't start**: Check that Postgres is healthy (`docker compose logs postgres`). The backend entrypoint polls Postgres and won't start migrations until it's ready.

**PowerSync crashes with storage errors**: PowerSync uses the `powersync_storage` database on the same Postgres instance for bucket storage. If the DB wasn't created, check `docker compose exec postgres psql -U postgres -c '\l'` — you should see `powersync_storage` listed. If missing, the init script (`docker/postgres-init/01-powersync.sh`) didn't run; wiping the volume with `docker compose down -v` and restarting will re-run it.

### Kubernetes / Helm

**Pods stuck in Pending**: Check PVC status with `kubectl get pvc -n thunderbolt`. If unbound, ensure a default StorageClass exists (`kubectl get sc`). On EKS, the EBS CSI driver must be installed.

**Postgres CrashLoopBackOff**: Check logs with `kubectl logs postgres-0 -n thunderbolt`. If you see "directory exists but is not empty" with `lost+found`, the `PGDATA` env var needs to point to a subdirectory (this is set in the chart).

**PowerSync CrashLoopBackOff**: Usually means the `powersync_storage` database doesn't exist on Postgres. The `postgres-init` ConfigMap creates it on first boot; if you inherited a pre-existing PVC, exec into the postgres pod and create it manually:

```bash
kubectl exec -it postgres-0 -n thunderbolt -- psql -U postgres -c \
  'CREATE DATABASE powersync_storage OWNER postgres;'
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
