# Thunderbolt Helm Chart

Helm chart for deploying Thunderbolt to any Kubernetes cluster.

For full documentation including local setup, GHCR images, and values reference, see the [main deployment guide](../README.md#2-kubernetes-with-helm-local-or-on-prem).

## Quick Start

```bash
# Install nginx-ingress (if not present)
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm install ingress-nginx ingress-nginx/ingress-nginx \
  --create-namespace -n ingress-nginx

# Deploy Thunderbolt
helm install thunderbolt . -n thunderbolt --create-namespace

# Watch pods
kubectl get pods -n thunderbolt -w
```

App is at `http://localhost` (with ingress). Demo login: `demo@thunderbolt.so` / `demo`.

## Values

See [values.yaml](values.yaml) for all configurable options. Key values:

| Value | Default | Description |
|-------|---------|-------------|
| `appUrl` | `http://localhost` | Base URL for CORS, auth, redirects |
| `imagePullSecrets` | `[]` | Registry pull secrets |
| `ingress.enabled` | `true` | Create Ingress resource |
| `ingress.host` | `""` | Set for production |
| `postgres.storage` | `5Gi` | Postgres PVC size |
| `mongo.storage` | `5Gi` | MongoDB PVC size |

## Templates

| Template | Resources | Purpose |
|----------|-----------|---------|
| `secrets.yaml` | Secret | OIDC, PowerSync JWT, Postgres, Better Auth credentials |
| `configmaps.yaml` | ConfigMaps | PowerSync config, Keycloak realm, Postgres init SQL |
| `postgres.yaml` | StatefulSet + Service | PostgreSQL with WAL replication + PVC |
| `mongo.yaml` | StatefulSet + Service + Job | MongoDB replica set + init hook |
| `backend.yaml` | Deployment + Service | Bun API with health probes |
| `frontend.yaml` | Deployment + Service | nginx SPA |
| `keycloak.yaml` | Deployment + Service | OIDC provider with realm import |
| `powersync.yaml` | Deployment + Service | Real-time sync engine |
| `ingress.yaml` | Ingress | Path-based routing |
