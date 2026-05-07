# Kubernetes

The Helm chart at [`deploy/k8s/`](https://github.com/thunderbird/thunderbolt/tree/main/deploy/k8s)
deploys the full Thunderbolt stack — frontend, backend, PostgreSQL, PowerSync,
Keycloak, and ingress — onto any conformant Kubernetes cluster from a single
`helm install`.

## Quick Start (Local)

This walkthrough takes you from "no cluster" to a working Thunderbolt at
`http://localhost` using [`kind`](https://kind.sigs.k8s.io/) (Kubernetes-in-Docker).
Total time: ~5 minutes.

### 1. Get a local cluster

`kubectl` is the CLI to talk to a cluster — it doesn't create one. Pick a tool
to spin one up locally:

| Option            | How                                                                  |
| ----------------- | -------------------------------------------------------------------- |
| **kind** (recommended) | `brew install kind` (see config below — bare `kind create cluster` won't work) |
| **Docker Desktop**     | Settings → Kubernetes → Enable. `kubectl cluster-info` to verify.    |
| **Minikube**           | `brew install minikube && minikube start`                            |

Create a `kind` cluster with the port mappings the chart's ingress needs:

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

The `extraPortMappings` and `ingress-ready` label are required for the chart's
ingress to be reachable at `http://localhost`. Without them the ingress install
in step 2 succeeds but isn't reachable from the host.

### 2. Install nginx-ingress

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

### 3. Generate the required secret

`backend.betterAuthSecretBase64` is the only required value with no default —
the chart fails to template without it. Generate one:

```bash
BETTER_AUTH_SECRET=$(openssl rand -base64 32 | tr -d '\n' | base64)
```

### 4. Install Thunderbolt

```bash
git clone https://github.com/thunderbird/thunderbolt.git
cd thunderbolt/deploy/k8s

helm install thunderbolt . \
  -n thunderbolt --create-namespace \
  --set backend.betterAuthSecretBase64="$BETTER_AUTH_SECRET"
```

The chart's default image repos point at the public images at
`ghcr.io/thunderbird/thunderbolt/*` — no pull secret needed for a local install.

### 5. Watch pods come up

```bash
kubectl get pods -n thunderbolt -w
```

First boot takes 1–2 minutes. Expected sequence:

1. `postgres-0` ready first (StatefulSet + PVC).
2. `keycloak`, `frontend`, `marketing` ready next.
3. `backend` and `powersync` may **show one or two restarts** — they race
   postgres on the first deploy. They self-heal once postgres accepts
   connections. End state: every pod `1/1 Running`.

### 6. Sign in

Open `http://localhost` in a private window. Click sign-in to bounce to
Keycloak. Demo credentials: `demo@thunderbolt.io` / `demo`.

After onboarding, drop in an AI provider key in app settings to start chatting.

## Routing

The chart's Ingress is path-based:

| Path           | Service        |
| -------------- | -------------- |
| `/v1/*`        | backend        |
| `/realms/*`    | keycloak       |
| `/resources/*` | keycloak       |
| `/powersync/*` | powersync      |
| `/*`           | frontend       |

## Cleanup

```bash
helm uninstall thunderbolt -n thunderbolt
kubectl delete namespace thunderbolt
kind delete cluster --name thunderbolt
```

## Configuration

See [`deploy/k8s/values.yaml`](https://github.com/thunderbird/thunderbolt/blob/main/deploy/k8s/values.yaml)
for all options. Key values:

| Value | Default | Description |
| --- | --- | --- |
| `backend.betterAuthSecretBase64` | `""` (REQUIRED) | Base64-encoded auth signing secret |
| `appUrl` | `http://localhost` | Base URL for CORS, auth callbacks, redirects |
| `frontend.image.repository` | `ghcr.io/thunderbird/thunderbolt/thunderbolt-frontend` | Frontend image |
| `backend.image.repository` | `ghcr.io/thunderbird/thunderbolt/thunderbolt-backend` | Backend image |
| `marketing.image.repository` | `ghcr.io/thunderbird/thunderbolt/thunderbolt-marketing` | Marketing site image |
| `imagePullSecrets` | `[]` | Registry pull secrets (empty for the default public images) |
| `ingress.enabled` | `true` | Create Ingress resource |
| `ingress.host` | `""` | Set to your hostname for production |
| `postgres.storage` | `5Gi` | Postgres PVC size |
| `backend.aiSecrets.anthropicApiKeyBase64` | `""` | Server-side Anthropic key (avoids browser CORS) |

## Production on EKS

For a production deployment to AWS EKS, use the Pulumi project:

```bash
cd deploy/pulumi
pulumi config set platform k8s
pulumi up
```

This creates the VPC and EKS cluster, pushes images, installs `nginx-ingress`,
and applies the chart automatically. See [Pulumi (AWS)](./pulumi.md).

## Differences from Docker Compose

| Concept             | Docker Compose              | Kubernetes                              |
| ------------------- | --------------------------- | --------------------------------------- |
| Service discovery   | Container names             | ClusterIP services (DNS)                |
| Ingress / routing   | nginx proxy in the frontend | Ingress resource                        |
| Persistent storage  | Docker volumes              | PersistentVolumeClaims                  |
| Health checks       | `healthcheck:` in compose   | `livenessProbe` / `readinessProbe`      |
| Config files        | Volume mounts               | ConfigMaps                              |
| Secrets             | `.env` file                 | Kubernetes Secret + Helm values         |
