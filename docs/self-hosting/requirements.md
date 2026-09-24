# Requirements

Before you deploy Thunderbolt you need a host or cluster, a PostgreSQL database, a hostname with TLS, and outbound access to at least one AI provider.

## What gets deployed

Thunderbolt is six services. The Kubernetes and AWS deployments run all six; the Docker Compose stack runs five, leaving out the marketing site.

| Service        | Purpose                                                            | Required                   |
| -------------- | ------------------------------------------------------------------ | -------------------------- |
| Frontend       | Serves the web app and proxies API calls to the backend            | Yes                        |
| Backend        | API, authentication, AI provider access, sync tokens               | Yes                        |
| PostgreSQL     | Application data, and the staging area the sync service reads from | Yes                        |
| PowerSync      | The sync service. Replicates data to each signed-in device         | Yes, for multi-device sync |
| Keycloak       | Bundled identity provider for OIDC and SAML sign-in                | No, with your own provider |
| Marketing site | Static landing page, blog and docs                                 | No                         |

## Deployment targets

| Target         | You need                                                                                              | Good for                               |
| -------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Docker Compose | One host with Docker 24+ and the Compose plugin                                                       | Demos, evaluations, small internal use |
| Kubernetes     | A conformant cluster, Helm 3, an ingress controller, and a default StorageClass for the database disk | Teams with an existing cluster         |
| AWS (Pulumi)   | An AWS account, the Pulumi CLI, and AWS credentials. Creates ECS Fargate or EKS                       | Green-field AWS deployments            |

The Helm chart assumes an nginx ingress controller by default, and any other controller works once you set the ingress class to match.

## CPU, memory and disk

The figures below are what the reference AWS deployment reserves for each service. Treat them as a starting point: no load test produced them, so measure your own usage before committing to a size.

| Service        | vCPU | Memory |
| -------------- | ---: | -----: |
| Backend        |  1.0 |   2 GB |
| PostgreSQL     |  1.0 |   2 GB |
| Keycloak       |  1.0 |   2 GB |
| PowerSync      |  0.5 |   1 GB |
| Frontend       | 0.25 | 0.5 GB |
| Marketing site | 0.25 | 0.5 GB |

### Small team (roughly up to 25 people)

One host running the Compose stack. 4 GB of RAM is the working minimum and 8 GB is comfortable; 4 vCPU covers the whole stack. Allow 40 GB of disk for container images, database volumes and logs.

### Larger deployments

Move PostgreSQL to a managed database and run the rest on Kubernetes or ECS. The backend keeps no state between requests, so you scale it by adding replicas. PowerSync holds an open sync connection per signed-in device, so its load tracks device count more than message volume.

Neither bundled stack scales PostgreSQL: both run a single instance with no high-availability option. We recommend moving to a managed database before anyone depends on the deployment. Only the Compose stack lets you do that, since the Helm chart and the Pulumi project always run the PostgreSQL they deploy.

## Database

Thunderbolt needs PostgreSQL. The Compose and Helm stacks run 17, and the prebuilt database image used on AWS runs 18.

The sync service replicates logically, so `wal_level` has to be `logical`; on a managed database that is a parameter-group setting and takes effect only after a restart. It also needs three objects of its own: a `powersync_role` login with `REPLICATION` and `BYPASSRLS`, a publication named `powersync` covering all tables, and a `powersync_storage` database on the same server to hold its sync buckets. The account you install with therefore has to be able to create a role, a publication and a database.

The bundled stacks create all three automatically on the database's first boot. Against a managed database you run that setup once by hand, and connect with `sslmode=require` if it terminates TLS. Keep `powersync_storage` itself off managed PostgreSQL 17: the sync service hangs partway through startup against RDS-managed 17 and logs no error.

Disk grows with message and attachment volume, and the sync buckets hold their own copy of synced rows, so total usage runs ahead of the application tables alone. The Helm chart defaults the database volume to `5Gi`, which is sized for evaluation. Raise it before real use, and verify your StorageClass allows volume expansion.

Thunderbolt does not store uploaded files on the server. Attachments stay on the device that added them and travel only inside the request that answers a message, so there is no S3 or blob-storage bucket to provision.

You can skip PostgreSQL entirely with `DATABASE_DRIVER=pglite`, which runs the server against an embedded database file and expects `DATABASE_URL` to point at a directory rather than a connection string. Use it for a first look and nothing else. The sync service cannot replicate from it, so multi-device sync does not work.

## TLS and DNS

Serve the app over HTTPS on anything other than `localhost`. Thunderbolt keeps each user's conversations in a database inside their browser, and browsers grant the storage and isolation features that requires only to pages served securely, so a plain-HTTP hostname breaks the app outright.

The containers themselves speak plain HTTP and expect TLS to terminate in front of them, at your ingress controller, load balancer, or a reverse proxy such as Caddy or Traefik. cert-manager handles the certificates on Kubernetes, and the Pulumi path uses AWS Certificate Manager.

One hostname is enough. Routing is path-based by default:

| Path            | Goes to   |
| --------------- | --------- |
| `/v1/`          | Backend   |
| `/powersync/`   | PowerSync |
| `/realms/`      | Keycloak  |
| `/resources/`   | Keycloak  |
| everything else | Frontend  |

You can instead give each service its own hostname (for example `app.`, `api.`, `auth.`, `powersync.`). Both layouts can be configured at once, with per-service hostnames taking precedence.

## Ports

Everything a user's browser talks to needs an address the browser can reach: the app, the API, the sync service, and the identity provider if you use the bundled one. Sync in particular runs as a direct browser connection, so an address that only resolves inside your container network leaves the app stuck offline.

On the Docker Compose stack each service is published on a host port, at the values in the example settings file, and each one has a variable you can override:

| Service    | Host port | Override with    |
| ---------- | --------: | ---------------- |
| Frontend   |      3000 | `FRONTEND_PORT`  |
| Backend    |      8000 | `BACKEND_PORT`   |
| Keycloak   |      8180 | `KEYCLOAK_PORT`  |
| PowerSync  |      8081 | `POWERSYNC_PORT` |
| PostgreSQL |      5434 | `POSTGRES_PORT`  |

Kubernetes and AWS publish no host ports. Traffic arrives at the ingress or load balancer and is routed by path.

## Outbound network access

| Destination                                          | Who calls it | When                                        |
| ---------------------------------------------------- | ------------ | ------------------------------------------- |
| `ghcr.io`, `quay.io`, `registry-1.docker.io`         | Every node   | Pulling container images                    |
| `api.anthropic.com`                                  | Backend      | `ANTHROPIC_API_KEY` is set                  |
| `api.fireworks.ai`                                   | Backend      | `FIREWORKS_API_KEY` is set                  |
| `inference.tinfoil.sh`                               | Backend      | Confidential models are in use              |
| `api.exa.ai`                                         | Backend      | `EXA_API_KEY` is set, for web search        |
| `api.resend.com`                                     | Backend      | `RESEND_API_KEY` is set, for sign-in email  |
| `us.i.posthog.com`                                   | Backend, app | `POSTHOG_API_KEY` is set                    |
| Your OTLP collector                                  | Backend      | `OTEL_EXPORTER_OTLP_ENDPOINT` is set        |
| `api.open-meteo.com`, `geocoding-api.open-meteo.com` | App, backend | Weather and location results                |
| `basemaps.cartocdn.com`                              | App          | Map tiles                                   |
| `cdn.crabnebula.app`                                 | Desktop app  | Update checks, official desktop builds only |
| Public relay servers run by n0                       | App, CLI     | Connecting the command-line tool to the app |

Confidential models are the ones that run inside a hardware-isolated enclave, which the app verifies before it sends anything. See [Models and providers](./models.md) for what that means in practice.

Two paths reach hosts you cannot list in advance. A user who supplies their own provider key, or connects a tool server over MCP (the Model Context Protocol, the open standard Thunderbolt uses to plug in external tools), has those requests forwarded by your API service, because a browser cannot call most of those endpoints itself. Pasting a link also makes the server fetch that page to build a preview. A strict outbound allowlist will break both.

Every published build reaches model providers through your server, desktop and mobile included. A direct device-to-provider path exists in the source, but no released build enables the flag that turns it on, so plan outbound access from your server.

## Identity

Pick one before you install, because the choice decides which environment variables you set.

| Option                 | Notes                                                                        |
| ---------------------- | ---------------------------------------------------------------------------- |
| Bundled Keycloak       | Ships with a `thunderbolt` realm and a demo user. Rotate every default first |
| Your own OIDC provider | Needs an issuer URL, client ID and client secret                             |
| Your own SAML provider | Needs an entry point, entity ID, issuer and signing certificate              |

The published web app image is built for single sign-on, which makes it the supported path for a self-hosted deployment. Emailed-code sign-in is a build-time choice rather than a setting, so using it means building the web app image yourself.

For Google or Microsoft sign-in from the desktop app, register all three loopback redirect URIs with that provider. The app tries the ports in order and uses the first that is free, and it sends `localhost`, so a URI registered as `127.0.0.1` will not match.

```text
http://localhost:17421
http://localhost:17422
http://localhost:17423
```

## Secrets to generate first

`BETTER_AUTH_SECRET` signs sessions and bearer tokens, and takes any random string of 32 characters or more. `POWERSYNC_JWT_SECRET` has the same length rule and must be identical on the backend and the PowerSync service. An AI provider key is not strictly required, but without one every user must add their own in-app.

```bash
openssl rand -base64 32
```

For the Helm chart, the sync secret must be encoded with base64url. Do not use `openssl rand -base64` for it: the `+`, `/` and `=` characters it can produce are rejected. Use one of these instead.

```bash
openssl rand 32 | basenc --base64url --wrap=0
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

## Client requirements

| Client  | Requirement                                                                                 |
| ------- | ------------------------------------------------------------------------------------------- |
| Web     | A current desktop browser, served over HTTPS. The app keeps a local database in the browser |
| Desktop | macOS 15 or later (Apple Silicon or Intel), Windows (x64 or arm64), or Linux x64            |
| Mobile  | iOS through TestFlight, Android through a Play Store internal track. Neither is public yet  |

The published desktop and mobile apps connect to Thunderbolt's hosted service. Pointing them at a self-hosted deployment means building them yourself with your own server URL, because the URL is fixed when the app is built.

## What is optional

| Component             | Leave it out if                                                                                                                              |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Keycloak              | You already run an OIDC or SAML identity provider                                                                                            |
| Marketing site        | You do not need the public landing page and docs alongside the app                                                                           |
| Multi-device sync     | Users only ever work on one device. Leave the sync service out and the app still works                                                       |
| Transactional email   | You sign users in through an identity provider. Email is only used for code and magic-link sign-in                                           |
| Analytics and tracing | Unset the PostHog and OpenTelemetry variables and nothing is sent                                                                            |
| Web search            | Unset the Exa key and the web search tool is unavailable                                                                                     |
| End-to-end encryption | Off by default. Turning it on requires each device to be approved before it syncs                                                            |
| Rate limiting         | On by default, though the bundled Compose and Helm configs switch it off. Switch it back on for anything reachable from outside your network |

The Kubernetes chart has no switch for the first two rows. It always installs Keycloak and the marketing site, so leaving out Keycloak there means pointing the API at your own provider and ignoring the workload you do not use.

## Next

- [Docker Compose](./docker-compose.md)
- [Kubernetes](./kubernetes.md)
- [Pulumi (AWS)](./pulumi.md)
- [Configuration reference](./configuration.md)
