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
| `backend.env.minAppVersion` | `""` | Minimum compatible app semver |
| `backend.env.cliDeviceRegistrationEnabled` | `"false"` | Server-owned CLI device registration gate |
| `marketing.image.repository` | `ghcr.io/thunderbird/thunderbolt/thunderbolt-marketing` | Marketing site image |
| `imagePullSecrets` | `[]` | Registry pull secrets (leave empty for the public images) |
| `nodeSelector` | `{}` | Node selector applied to every pod, to pin workloads to a node pool (e.g. `kubernetes.io/arch: amd64`) |
| `ingress.enabled` | `true` | Create Ingress resource |
| `ingress.host` | `""` | Set to your hostname for production |
| `postgres.storage` | `5Gi` | Postgres PVC size |
| `postgres.storageClassName` | `""` (uses cluster default) | StorageClass for the Postgres PVC. Set explicitly on clusters with a node-local default or node churn; `"-"` binds a PV you provisioned yourself. New installs only, see below |
| `backend.aiSecrets.anthropicApiKeyBase64` | `""` | Server-side Anthropic key (avoids browser CORS) |
| `keycloak.enabled` | `true` | Deploy the bundled Keycloak. Set `false` when using an external `oidc.issuer` |
| `oidc.issuer` | `""` | External IdP issuer URL (leave empty to use the bundled Keycloak) |
| `oidc.discoveryUrl` | `""` | Override the discovery document URL when it differs from `<issuer>/.well-known/openid-configuration` |
| `oidc.clientId` | `""` | External IdP client ID |
| `oidc.clientSecretBase64` | `""` | Base64-encoded external IdP client secret |

See the [CLI device rollout guide](../../docs/self-hosting/configuration.md#cli-device-rollout) before enabling registration.

### Changing Postgres storage after install

`postgres.storage` and `postgres.storageClassName` both render into the
StatefulSet's `volumeClaimTemplates`, which Kubernetes will not let you change
on an existing object, so `helm upgrade` fails outright. The two need very
different remedies, and only one of them touches your data.

**Resizing the volume (`postgres.storage`) is not destructive.** Delete the
StatefulSet while leaving its pod and claim in place, then upgrade: the claim
keeps its identity and the data stays where it is.

```bash
kubectl delete statefulset postgres -n thunderbolt --cascade=orphan
helm upgrade thunderbolt . -n thunderbolt --reuse-values --set postgres.storage=10Gi
```

That updates the template. On a StorageClass with `allowVolumeExpansion: true`,
which is the default on the major clouds, grow the existing disk too:

```bash
kubectl patch pvc pg-data-postgres-0 -n thunderbolt \
  -p '{"spec":{"resources":{"requests":{"storage":"10Gi"}}}}'
```

**Changing the StorageClass is destructive**, because the new class provisions a
new volume and nothing copies the old one across. Budget downtime, and treat the
dump as your only copy.

```bash
# 1. Stop anything that writes, then dump, then verify the dump is readable.
kubectl scale -n thunderbolt deploy/backend deploy/powersync --replicas=0
kubectl exec -n thunderbolt postgres-0 -- \
  pg_dump -U postgres -Fc postgres > thunderbolt.dump
pg_restore --list thunderbolt.dump > /dev/null && echo "dump OK"

# 2. Keep the old volume even if the class reclaims it, as a fallback.
kubectl patch pv "$(kubectl get pvc pg-data-postgres-0 -n thunderbolt \
  -o jsonpath='{.spec.volumeName}')" \
  -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'

# 3. Remove the StatefulSet and its claim. The orphaned pod still mounts the
#    volume, so it has to go before the claim will delete rather than hang.
kubectl delete statefulset postgres -n thunderbolt --cascade=orphan
kubectl delete pod postgres-0 -n thunderbolt
kubectl delete pvc pg-data-postgres-0 -n thunderbolt

# 4. Recreate on the new class, with the writers still down. The upgrade resets
#    both replica counts, so pin them to 0 here.
helm upgrade thunderbolt . -n thunderbolt --reuse-values \
  --set postgres.storageClassName=<class> \
  --set backend.replicas=0 --set powersync.replicas=0

# 5. Wait for the new volume to bind and Postgres to finish initialising.
#    Provisioning takes a minute or two on a cloud StorageClass.
kubectl rollout status statefulset/postgres -n thunderbolt --timeout=10m

# 6. Restore, and only bring the writers back if it succeeded. Step 4 saved
#    replicas=0 into the release, so --reuse-values alone would leave them
#    stopped: pass the counts you were running before.
kubectl exec -i -n thunderbolt postgres-0 -- \
  pg_restore -U postgres -d postgres --clean --if-exists < thunderbolt.dump
helm upgrade thunderbolt . -n thunderbolt --reuse-values \
  --set postgres.storageClassName=<class> \
  --set backend.replicas=1 --set powersync.replicas=1
```

Do not skip step 5. `helm upgrade` returns as soon as the objects are accepted,
long before the volume is bound, and a `pg_restore` against a pod that is still
starting fails in ways that are easy to miss.

The sync service's own `powersync_storage` database is deliberately not in the
dump. It rebuilds itself from the application database, so after this every
client does one full re-sync.

### Using an external identity provider

Set `keycloak.enabled=false` and the `oidc.*` values instead. Whatever OIDC
provider you use, register this callback URL with it:

```
<appUrl>/v1/api/auth/sso/callback/sso
```

```bash
helm upgrade thunderbolt . -n thunderbolt \
  --reuse-values \
  --set keycloak.enabled=false \
  --set oidc.issuer=https://idp.example.com/application/o/thunderbolt/ \
  --set oidc.clientId=<client-id> \
  --set-string oidc.clientSecretBase64="$(printf %s '<client-secret>' | base64 | tr -d '\n')"
```

GNU coreutils `base64` (the default on Linux) wraps its output every 76
characters; an external IdP's client secret is often long enough to wrap,
and an unquoted `$(...)` then passes the wrapped lines to `helm` as
separate arguments. `tr -d '\n'` strips the wrapping and the quotes keep
the result as one argument; `--set-string` keeps a base64 value that
happens to look numeric from being coerced. For a real deployment, put
`oidc.clientSecretBase64` in a values file or an external secret manager
instead of `--set` — it otherwise ends up in shell history and in the
process list.

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
