# Thunderbolt Helm Chart

Helm chart for deploying Thunderbolt to any Kubernetes cluster. The chart is
self-contained: Postgres, PowerSync, Keycloak, backend, frontend, and ingress
all come up from a single `helm install`.

For production / on-prem detail beyond the local quick-start, see the
[main deployment guide](../README.md#2-kubernetes-with-helm-local-or-on-prem).

## Quick Start (Local)

This walkthrough takes you from "no cluster" to a working Thunderbolt at
`http://localhost` using [`kind`](https://kind.sigs.k8s.io/) (Kubernetes-in-Docker).
Total time: ~5 minutes.

### 1. Get a local cluster

`kubectl` is the CLI to talk to a cluster — it doesn't create one. Pick a tool
to spin up a cluster locally. We recommend `kind`:

```bash
brew install kind helm   # or your platform's equivalent
```

Other options that work with this chart: Docker Desktop's built-in Kubernetes,
`minikube`, `k3d`. The rest of this guide assumes `kind`.

Create a cluster with port mappings for the ingress controller (the chart's
ingress binds to host ports `:80` and `:443`):

```bash
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

### 2. Install nginx-ingress (kind flavor)

`kind` requires a specific ingress-nginx manifest that binds to the
`ingress-ready=true` node we just labeled. The official kind manifest:

```bash
kubectl apply -f https://kind.sigs.k8s.io/examples/ingress/deploy-ingress-nginx.yaml

kubectl wait --namespace ingress-nginx \
  --for=condition=ready pod \
  --selector=app.kubernetes.io/component=controller \
  --timeout=120s
```

> **Other clusters:** if you're not using `kind`, install ingress-nginx via the
> standard chart instead: `helm install ingress-nginx ingress-nginx/ingress-nginx -n ingress-nginx --create-namespace --set controller.service.type=LoadBalancer`.

### 3. Generate the required secret

`backend.betterAuthSecretBase64` is the only required value with no default —
the chart fails to template without it. Generate one:

```bash
BETTER_AUTH_SECRET=$(openssl rand -base64 32 | tr -d '\n' | base64)
```

### 4. Install Thunderbolt

```bash
helm install thunderbolt . \
  -n thunderbolt --create-namespace \
  --set backend.betterAuthSecretBase64="$BETTER_AUTH_SECRET"
```

The chart's default image repos point at the public images at
`ghcr.io/thunderbird/thunderbolt/*` — no pull secret needed.

### 5. Watch pods come up

```bash
kubectl get pods -n thunderbolt -w
```

First boot takes 1–2 minutes. Expected sequence:

1. `postgres-0` ready first (StatefulSet + PVC)
2. `keycloak`, `frontend`, `marketing` all ready next
3. `backend` and `powersync` may **show one or two restarts** — they race
   postgres on the first deploy. They self-heal once postgres accepts
   connections. End state: every pod `1/1 Running`.

### 6. Sign in

Open `http://localhost` in a private window. Click sign-in. You'll be redirected
to Keycloak. Demo credentials: `demo@thunderbolt.io` / `demo`.

After onboarding, drop in an AI provider key in app settings to start chatting.

> **Heads-up:** browser-direct calls to `api.anthropic.com` from a BYO key flow
> are subject to Anthropic's CORS policy. Production deploys should set
> `backend.aiSecrets.anthropicApiKeyBase64` (or another provider's key) so the
> backend handles inference instead of the browser. See [Values](#values).

## Cleanup

```bash
helm uninstall thunderbolt -n thunderbolt
kubectl delete namespace thunderbolt
kind delete cluster --name thunderbolt
```

## Values

See [values.yaml](values.yaml) for all configurable options. Key values:

| Value | Default | Description |
|-------|---------|-------------|
| `backend.betterAuthSecretBase64` | `""` (REQUIRED) | Base64-encoded auth signing secret |
| `appUrl` | `http://localhost` | Base URL for CORS, auth callbacks, redirects |
| `frontend.image.repository` | `ghcr.io/thunderbird/thunderbolt/thunderbolt-frontend` | Frontend image |
| `backend.image.repository` | `ghcr.io/thunderbird/thunderbolt/thunderbolt-backend` | Backend image |
| `marketing.image.repository` | `ghcr.io/thunderbird/thunderbolt/thunderbolt-marketing` | Marketing site image |
| `imagePullSecrets` | `[]` | Registry pull secrets (leave empty for the public images) |
| `ingress.enabled` | `true` | Create Ingress resource |
| `ingress.host` | `""` | Set to your hostname for production |
| `postgres.storage` | `5Gi` | Postgres PVC size |
| `backend.aiSecrets.anthropicApiKeyBase64` | `""` | Server-side Anthropic key (avoids browser CORS) |

## Templates

| Template | Resources | Purpose |
|----------|-----------|---------|
| `secrets.yaml` | Secret | OIDC, PowerSync JWT, Postgres, Better Auth credentials |
| `configmaps.yaml` | ConfigMaps | PowerSync config, Keycloak realm, Postgres init SQL |
| `postgres.yaml` | StatefulSet + Service | PostgreSQL with WAL replication + PVC; hosts app DB and PowerSync bucket storage |
| `backend.yaml` | Deployment + Service | Bun API with health probes |
| `frontend.yaml` | Deployment + Service | nginx SPA |
| `keycloak.yaml` | Deployment + Service | OIDC provider with realm import |
| `powersync.yaml` | Deployment + Service | Real-time sync engine |
| `ingress.yaml` | Ingress | Path-based routing |
