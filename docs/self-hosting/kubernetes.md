# Kubernetes

[`deploy/k8s/`](https://github.com/thunderbird/thunderbolt/tree/main/deploy/k8s) is a Helm chart
deploying the full stack (frontend, backend, PostgreSQL, PowerSync, Keycloak, ingress) to any
conformant cluster in one `helm install`.

## Quick Start (Local)

Thunderbolt at `http://localhost` via [`kind`](https://kind.sigs.k8s.io/), in ~5 minutes.

### 1. Get a local cluster

`kubectl` does not create a cluster:

| Option                 | How                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------- |
| **kind** (recommended) | `brew install kind`, then the config below (bare `kind create cluster` won't work) |
| **Docker Desktop**     | Settings → Kubernetes → Enable. Verify with `kubectl cluster-info`.                |
| **Minikube**           | `brew install minikube && minikube start`                                          |

`extraPortMappings` and the `ingress-ready` label are required: without them the step 2 ingress
installs but is unreachable from the host.

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

### 2. Install nginx-ingress

**kind** (the kind-flavored manifest, which binds to the labeled node):

```bash
kubectl apply -f https://kind.sigs.k8s.io/examples/ingress/deploy-ingress-nginx.yaml

kubectl wait --namespace ingress-nginx \
  --for=condition=ready pod \
  --selector=app.kubernetes.io/component=controller \
  --timeout=120s
```

**Docker Desktop / Minikube** (the standard chart):

```bash
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm install ingress-nginx ingress-nginx/ingress-nginx \
  --create-namespace -n ingress-nginx \
  --set controller.service.type=LoadBalancer
```

### 3. Generate the required secret

`backend.betterAuthSecretBase64` is the only required value with no default; templating fails
without it.

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

Default repos are the public `ghcr.io/thunderbird/thunderbolt/*` images: no pull secret locally.

### 5. Watch pods come up

```bash
kubectl get pods -n thunderbolt -w
```

First boot takes 1–2 minutes:

1. `postgres-0` ready first (StatefulSet + PVC).
2. `keycloak`, `frontend`, `marketing` next.
3. `backend` and `powersync` may **restart once or twice**, racing postgres on the first deploy,
   and self-heal once postgres accepts connections. End state: every pod `1/1 Running`.

### 6. Sign in

Open `http://localhost` in a private window; sign-in bounces to Keycloak. Demo credentials:
`demo@thunderbolt.io` / `demo`. After onboarding, add an AI provider key in settings to start
chatting.

## Routing

The Ingress is path-based:

| Path           | Service   |
| -------------- | --------- |
| `/v1/*`        | backend   |
| `/realms/*`    | keycloak  |
| `/resources/*` | keycloak  |
| `/powersync/*` | powersync |
| `/*`           | frontend  |

Path rules always render (the enterprise layout). `ingress.hostnames` (`marketing`, `app`, `api`,
`auth`, `powersync`) adds a host-header rule per service serving `/` (the preview layout); host
rules win for those hostnames, path rules stay as fallback.

## Cleanup

```bash
helm uninstall thunderbolt -n thunderbolt
kubectl delete namespace thunderbolt
kind delete cluster --name thunderbolt
```

## Configuration

Key values; full list in
[`deploy/k8s/values.yaml`](https://github.com/thunderbird/thunderbolt/blob/main/deploy/k8s/values.yaml):

| Value                                     | Default                                                 | Description                                                 |
| ----------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------- |
| `backend.betterAuthSecretBase64`          | `""` (REQUIRED)                                         | Base64-encoded auth signing secret                          |
| `appUrl`                                  | `http://localhost`                                      | Base URL for CORS, auth callbacks, redirects                |
| `frontend.image.repository`               | `ghcr.io/thunderbird/thunderbolt/thunderbolt-frontend`  | Frontend image                                              |
| `backend.image.repository`                | `ghcr.io/thunderbird/thunderbolt/thunderbolt-backend`   | Backend image                                               |
| `marketing.image.repository`              | `ghcr.io/thunderbird/thunderbolt/thunderbolt-marketing` | Marketing site image                                        |
| `imagePullSecrets`                        | `[]`                                                    | Registry pull secrets (empty for the default public images) |
| `ingress.enabled`                         | `true`                                                  | Create Ingress resource                                     |
| `ingress.host`                            | `""`                                                    | Set to your hostname for production                         |
| `ingress.hostnames`                       | `{}`                                                    | Per-service hostnames for host-header routing (see above)   |
| `postgres.storage`                        | `5Gi`                                                   | Postgres PVC size                                           |
| `backend.aiSecrets.anthropicApiKeyBase64` | `""`                                                    | Server-side Anthropic key (avoids browser CORS)             |

## Production on EKS

The Pulumi project creates the VPC and EKS cluster, pushes images, installs `nginx-ingress`, and
applies the chart. See [Pulumi (AWS)](./pulumi.md).

```bash
cd deploy/pulumi
pulumi config set platform k8s
pulumi up
```

## Differences from Docker Compose

| Concept            | Docker Compose              | Kubernetes                         |
| ------------------ | --------------------------- | ---------------------------------- |
| Service discovery  | Container names             | ClusterIP services (DNS)           |
| Ingress / routing  | nginx proxy in the frontend | Ingress resource                   |
| Persistent storage | Docker volumes              | PersistentVolumeClaims             |
| Health checks      | `healthcheck:` in compose   | `livenessProbe` / `readinessProbe` |
| Config files       | Volume mounts               | ConfigMaps                         |
| Secrets            | `.env` file                 | Kubernetes Secret + Helm values    |
