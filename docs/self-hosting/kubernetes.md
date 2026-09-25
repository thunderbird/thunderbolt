# Kubernetes

One `helm install` brings up the whole stack: the app, the API, PostgreSQL, the sync service, Keycloak, and an Ingress that routes between them. Nothing outside the cluster is required except registry egress for the images, and an AI provider if you configure one.

If you only want to see Thunderbolt working, we recommend [Docker Compose](./docker-compose.md) or the [local cluster walkthrough](#try-it-on-a-local-cluster) below.

## What the chart deploys

| Workload   | Runs as     | Notes                                                                    |
| ---------- | ----------- | ------------------------------------------------------------------------ |
| Frontend   | Deployment  | The chat app, served as static files.                                    |
| Backend    | Deployment  | The API. Health-probed, migrates the database on startup.                |
| PostgreSQL | StatefulSet | One instance with a persistent volume. Holds the app and sync databases. |
| PowerSync  | Deployment  | The sync service that keeps devices in agreement.                        |
| Keycloak   | Deployment  | Identity provider. Its sign-in configuration is imported when it starts. |
| Marketing  | Deployment  | The landing page and these docs. Deployed unconditionally.               |
| Ingress    | Ingress     | Routes every path to the right service.                                  |

Replica counts are configurable for `frontend`, `backend` and `marketing`. PostgreSQL is fixed at one instance and the chart has no high-availability database option. Keycloak and PowerSync expose a `replicas` value but must stay at one: the bundled Keycloak keeps its database inside the pod, so each replica would hold a different one, and PowerSync runs the `unified` role with a single replicator.

## Prerequisites

| You need               | Detail                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| A cluster              | Any conformant cluster serving `networking.k8s.io/v1` Ingress (Kubernetes 1.19 or newer). |
| Helm and kubectl       | Helm 3.8 or newer, which is where installing a chart straight from OCI became stable.     |
| An ingress controller  | The chart requests ingress class `nginx`. Change it with `ingress.className`.             |
| A default StorageClass | PostgreSQL claims a 5 GiB volume on install.                                              |

No CPU or memory requests are set by default, so the scheduler treats every pod as best-effort. Set `resources` per component before you run this anywhere real.

## Generate the secrets

Two values need generating. The first has no default and the chart refuses to render without it.

```bash
BETTER_AUTH_SECRET=$(openssl rand -base64 32 | tr -d '\n' | base64)
POWERSYNC_JWT_SECRET=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')
```

The sync secret must be **base64url** encoded, not standard base64. The same string is used to sign sync tokens and to verify them, and the verifier rejects the `+`, `/` and `=` characters that `openssl rand -base64` can emit. The decoded value must be at least 32 characters or the API will not start.

The chart ships a working default for the sync secret, the two database passwords, the Keycloak administrator login, and the OpenID Connect (OIDC) client secret that Thunderbolt uses to authenticate against Keycloak.

> Every one of those defaults is published openly in the project's source. Override all of them before anyone outside your team can reach the deployment.

## Install

```bash
git clone https://github.com/thunderbird/thunderbolt.git
cd thunderbolt/deploy/k8s

helm install thunderbolt . \
  -n thunderbolt --create-namespace \
  --set appUrl="https://thunderbolt.example.com" \
  --set ingress.host="thunderbolt.example.com" \
  --set backend.betterAuthSecretBase64="$BETTER_AUTH_SECRET" \
  --set powersync.jwt.secretBase64="$POWERSYNC_JWT_SECRET" \
  --set keycloak.demoUserEnabled=false
```

Each release also publishes the chart to `oci://ghcr.io/thunderbird/charts/thunderbolt`, so you can install without cloning. Every image the chart pulls is public and no pull secret is needed: the app, the API and the landing page come from `ghcr.io/thunderbird/thunderbolt/`, while PostgreSQL, Keycloak and the sync service come from their projects' own registries. Don't depend on a deployment running `latest`: the tag is rebuilt continuously. Pin `<component>.image.tag` to a published version instead. See [Upgrading](./upgrading.md).

Past a handful of flags we recommend copying the chart's `values.yaml`, which documents every option, and passing it with `-f`.

## Verify the deployment

```bash
kubectl get pods -n thunderbolt -w
```

First boot takes one to two minutes. `postgres-0` becomes ready first, then `keycloak`, `frontend` and `marketing`. `backend` and `powersync` may restart once or twice: they race PostgreSQL on the first install and recover on their own once it accepts connections. End state is every pod `1/1 Running`.

```bash
curl https://thunderbolt.example.com/v1/health
```

Deeper probes covering the database, the sync service, email and the model catalog are available behind a bearer token, described in the [configuration reference](./configuration.md#health-checks). If a pod is stuck, start with `kubectl logs -n thunderbolt deploy/backend`.

## Routing

The Ingress routes by path under a single hostname. Set `ingress.enabled=false` if you front the cluster with your own gateway.

| Path            | Goes to   |
| --------------- | --------- |
| `/v1/`          | Backend   |
| `/realms/`      | Keycloak  |
| `/resources/`   | Keycloak  |
| `/powersync/`   | PowerSync |
| Everything else | Frontend  |

Leave `ingress.host` empty and the path rules apply to any hostname that reaches the controller, which is how the local walkthrough works on `localhost`.

> The `/powersync/` rule renders, but sync does not work through it. The chart sets `POWERSYNC_URL` to the in-cluster `http://powersync:8080` and offers no value to change it, so that is the address the browser is handed; the Ingress does not strip the path prefix either. Multi-device sync needs `ingress.hostnames.powersync` below.

If you would rather give each service its own hostname, set any of the five keys under `ingress.hostnames`:

```yaml
ingress:
  host: app.example.com
  hostnames:
    marketing: example.com
    app: app.example.com
    api: api.example.com
    auth: auth.example.com
    powersync: powersync.example.com
```

Host rules win for the hostnames you list, and the path rules always render as a fallback for everything else, so you can move one service onto its own hostname without rewriting the rest.

## TLS

The chart does not render a TLS section on the Ingress. Terminate TLS in front of it:

- Give your ingress controller a default certificate, or
- Terminate at a cloud load balancer that fronts the controller, or
- Add a `tls` block to the Ingress yourself after install.

We recommend the first, with cert-manager issuing the certificate. It keeps renewal out of the chart and out of your upgrade path.

Whichever you choose, set `appUrl` to the `https://` URL. It decides which browser origins are allowed to call the API, where sign-in returns the user to, and the return addresses registered with Keycloak. An `appUrl` that does not match the address users actually visit produces sign-in loops rather than a clear error. Changing `appUrl` on a later upgrade restarts the API and Keycloak by itself, and Keycloak re-imports its sign-in configuration at the new address. Expect a brief interruption to sign-in while that happens.

## Values that matter

| Value                                 | Default                 | What it controls                                                                                                                                                 |
| ------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend.betterAuthSecretBase64`      | none, **required**      | Base64 of the secret that signs sessions.                                                                                                                        |
| `appUrl`                              | `http://localhost`      | Public base URL. CORS, auth callbacks, Keycloak redirect URIs.                                                                                                   |
| `ingress.enabled`                     | `true`                  | Whether the chart creates an Ingress at all.                                                                                                                     |
| `ingress.host`                        | empty                   | Hostname for the path-based rules. Empty means any host.                                                                                                         |
| `ingress.className`                   | `nginx`                 | Which ingress controller claims the resource.                                                                                                                    |
| `ingress.hostnames`                   | empty                   | Per-service hostnames. See [Routing](#routing).                                                                                                                  |
| `powersync.jwt.secretBase64`          | a published dev secret  | Base64url of the sync signing secret. Replace it.                                                                                                                |
| `postgres.storage`                    | `5Gi`                   | Size of the database volume. Set it before install, not after.                                                                                                   |
| `postgres.credentials.passwordBase64` | base64 of `postgres`    | Database password. Replace it.                                                                                                                                   |
| `postgres.sslmode`                    | `disable`               | `require` or stricter when the database terminates TLS.                                                                                                          |
| `keycloak.admin.password`             | `admin`                 | Keycloak admin password. Replace it.                                                                                                                             |
| `keycloak.oidc.clientSecretBase64`    | a published dev secret  | Base64 of the sign-in client secret. Replace it.                                                                                                                 |
| `powersync.db.passwordBase64`         | a published dev secret  | Base64 of the sync service's database password. Replace it.                                                                                                      |
| `keycloak.demoUserEnabled`            | `true`                  | Whether `demo@thunderbolt.io` exists. Set `false` for real deployments.                                                                                          |
| `backend.aiSecrets.*`                 | empty                   | Base64 provider keys: `anthropicApiKeyBase64`, `fireworksApiKeyBase64`, `exaApiKeyBase64`, `thunderboltInferenceApiKeyBase64`. Empty means that provider is off. |
| `backend.env.rateLimitEnabled`        | `"false"`               | Per-client rate limiting on the API.                                                                                                                             |
| `backend.env.minAppVersion`           | empty                   | Reject clients older than this version. Empty disables the check.                                                                                                |
| `<component>.image.repository`        | public GHCR / upstream  | Point at a mirror. Pair with `imagePullSecrets` if it is private.                                                                                                |
| `<component>.image.tag`               | `latest` for our images | Pin this. See [Install](#install).                                                                                                                               |
| `<component>.replicas`                | `1`                     | Copies of that workload. Not available for PostgreSQL.                                                                                                           |
| `<component>.resources`               | empty                   | Requests and limits for that container.                                                                                                                          |
| `<component>.podAnnotations`          | empty                   | Merged over the chart-wide `podAnnotations`.                                                                                                                     |
| `imagePullSecrets`                    | empty                   | Only needed if you mirror the images to a private registry.                                                                                                      |

`<component>` is one of `frontend`, `marketing`, `backend`, `postgres`, `powersync`, `keycloak`.

Secret values ending in `Base64` are base64 of the raw value, not the raw value: `echo -n "your-key" | base64`.

> Don't put `@`, `:`, `/`, `?` or `#` in the database password. It silently corrupts the connection string and the API never reaches the database.

Provider keys set here are held by the API, so the browser never holds them and never calls a provider directly. Users can still bring their own keys in the app instead, but we recommend a server-side key: some providers reject browser-origin requests outright. Every setting the API understands is in the [configuration reference](./configuration.md).

## Try it on a local cluster

Roughly five minutes to Thunderbolt at `http://localhost`, using [kind](https://kind.sigs.k8s.io/).

A bare `kind create cluster` will not work. The port mappings and the node label below are what make the ingress controller reachable from your machine.

```bash
brew install kind helm

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

Install the kind-flavored ingress controller, which binds to the node you just labeled:

```bash
kubectl apply -f https://kind.sigs.k8s.io/examples/ingress/deploy-ingress-nginx.yaml

kubectl wait --namespace ingress-nginx \
  --for=condition=ready pod \
  --selector=app.kubernetes.io/component=controller \
  --timeout=120s
```

On Docker Desktop or minikube, install the standard controller instead:

```bash
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm install ingress-nginx ingress-nginx/ingress-nginx \
  --create-namespace -n ingress-nginx \
  --set controller.service.type=LoadBalancer
```

Install the chart with defaults and only the required secret, pulled straight from the registry so there is nothing to clone:

```bash
helm install thunderbolt oci://ghcr.io/thunderbird/charts/thunderbolt \
  -n thunderbolt --create-namespace \
  --set backend.betterAuthSecretBase64="$(openssl rand -base64 32 | tr -d '\n' | base64)"
```

Open `http://localhost` in a private window. Sign-in redirects to Keycloak; the demo credentials are `demo@thunderbolt.io` / `demo`. Add an AI provider key in settings to start chatting.

Tear it down with:

```bash
helm uninstall thunderbolt -n thunderbolt
kubectl delete namespace thunderbolt
kind delete cluster --name thunderbolt
```

## Before you put it in front of users

- Set `keycloak.demoUserEnabled=false`, and rotate the Keycloak admin password, the OIDC client secret, the database password and the sync secret.
- Serve over HTTPS and set `appUrl` to that URL.
- Set `resources` on every component.
- Back up the PostgreSQL volume. It holds accounts, sessions and the server copy of synced data.
- Decide how users reach a model: a provider key on the server, or each user's own key.

**Don't use the bundled Keycloak past evaluation.** It runs in development mode with its database inside the pod and no persistent volume, so anything you configure in its admin console is lost when the pod restarts, and the sign-in configuration is re-imported from scratch. Point Thunderbolt at your own identity provider instead. The chart has no values for that, so you set the API's identity settings yourself. See [Configuration](./configuration.md#oidc).

The database is always the one the chart deploys. There is no value for pointing at an external PostgreSQL such as RDS: `postgres.sslmode` exists for a database that terminates TLS, but the connection target itself is fixed to the in-cluster instance.

## Upgrades and rollbacks

```bash
helm upgrade thunderbolt . -n thunderbolt -f my-values.yaml
helm rollback thunderbolt -n thunderbolt
```

Upgrading rolls each workload whose settings changed and runs any pending database migrations when the API starts. `keycloak.demoUserEnabled` is the exception: it alters only the sign-in configuration Keycloak reads at boot, and nothing about the Keycloak pod itself, so the pod is never replaced and the change does not take effect on its own. Apply it by hand:

```bash
kubectl rollout restart deployment/keycloak -n thunderbolt
```

That restart also discards anything configured in the Keycloak admin console since its pod started.

`helm uninstall` leaves the PostgreSQL volume behind. Delete the namespace to remove the data with it.

## Related

- [Configuration](./configuration.md): every setting the API reads, with defaults.
- [AWS with Pulumi](./pulumi.md): builds a cluster and installs this same chart, or runs the stack on Fargate instead.
- [Docker Compose](./docker-compose.md): the same stack on one machine.
