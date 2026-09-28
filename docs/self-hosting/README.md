# Self-Hosting

Thunderbolt runs entirely on infrastructure you control, with no vendor control plane to call home to. Traffic leaves your network to reach the AI providers you configure and a short list of feature endpoints, every one of which is listed in [Requirements](./requirements.md).

> **Evaluation.** Thunderbolt has not completed a security audit. Deploy it for evaluation and internal testing, not yet for production.

## Pick a deployment path

| Path                                  | What it takes                                                                                                            | How it scales                                                             | Good for                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [Docker Compose](./docker-compose.md) | Docker on one machine, a config file, one command. The first run builds the images on that host and takes a few minutes. | One host, one copy of each service, no redundancy.                        | Demos, evaluation, a small internal tool, a test environment.           |
| [Kubernetes](./kubernetes.md)         | An existing cluster, an ingress controller, TLS, one `helm install`.                                                     | Set a replica count per stateless service. Rolling upgrades through Helm. | Teams that already run Kubernetes and have people who operate it.       |
| [AWS with Pulumi](./pulumi.md)        | An AWS account and the Pulumi CLI. Builds the network and compute from zero.                                             | Same as Kubernetes if you choose EKS; managed load balancing either way.  | A green-field AWS deployment you want described as code from the start. |

The AWS path offers two targets from the same project: ECS Fargate, which gives you no cluster to operate, or EKS, which installs the same Helm chart Kubernetes users get. Choose Fargate unless you already run EKS.

We recommend starting with Docker Compose, even if you intend to run Kubernetes later. Every path runs the same API against the same environment variables, though each exposes a different subset of them, so nothing you learn is wasted.

## What a deployment contains

The app is the chat interface, served to a browser as a static site. The API behind it handles sign-in, authorizes each device for sync, fetches link previews, runs web search, and makes the outbound calls to AI providers.

Three more pieces run alongside them. PostgreSQL holds accounts, sessions, and the server-side copy of synced data. PowerSync keeps every signed-in device holding the same data and streams changes as they happen; it is part of the stack and needs no external service. Keycloak, the identity provider, arrives preloaded with a realm and a demo user, so sign-in works on first boot.

Only the database and the identity provider can be replaced. Any OIDC or SAML identity provider can stand in for Keycloak. The database can be replaced on Docker Compose: drop the bundled PostgreSQL and point `DATABASE_URL` at a managed service such as Amazon RDS, after creating the replication role and publication the sync service needs. That value is written into `deploy/docker-compose.yml` rather than read from `deploy/.env`, so it has to be changed in the compose file. The Kubernetes chart and the AWS project do not offer that; both always run the PostgreSQL they deploy.

Separately, the sync service keeps its own bookkeeping in a second database (`powersync_storage`) on the same server. Don't put that one on managed PostgreSQL 17. The sync service hangs partway through startup against RDS-managed 17 and logs nothing to tell you why. Keep it on the PostgreSQL the deployment ships, or on an unmanaged instance.

The Kubernetes and AWS paths also deploy a small static site for the landing page and these docs; Docker Compose does not, and on Kubernetes there is no switch to turn it off.

Each user's device keeps its own local database and reads and writes there first, so reading and editing keep working when your server is unreachable. Model replies, web search and link previews do not: those go through your API. Sync is what brings those local databases into agreement, not where the app reads from.

## What you get by default

| Setting               | Default                                                                                                                                                                                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in               | OIDC through the bundled Keycloak. SAML is also supported: switch `AUTH_MODE` to `saml` and supply your provider's details.                                                                                                                                |
| Identity realm        | `thunderbolt`, imported the first time Keycloak boots.                                                                                                                                                                                                     |
| Demo user             | `demo@thunderbolt.io` / `demo`                                                                                                                                                                                                                             |
| Keycloak admin        | `admin` / `admin` on every path, AWS included. Set `keycloakAdminPassword` before anyone can reach the deployment.                                                                                                                                         |
| Waitlist              | Off. Anyone your identity provider authenticates can sign in.                                                                                                                                                                                              |
| Analytics             | Off. Nothing is sent unless you configure an analytics service, and each user still has to opt in.                                                                                                                                                         |
| End-to-end encryption | Off. Turning on `E2EE_ENABLED` encrypts the covered content columns on the device, so your servers hold ciphertext for those; accounts, sessions and uncovered columns stay readable. Each new device has to be approved from one the user already trusts. |

> Every credential in the table above is published in this repository. Rotate all of them and delete the demo user before anyone outside your team can reach the deployment.

## Before you start

- A host or cluster: 4 GB of RAM is the floor for the single-host path, and 8 GB is comfortable.
- A domain and DNS control, for a shared deployment only. Docker Compose on `localhost` needs neither.
- TLS certificates, because anything other than `localhost` must be served over HTTPS. Issue them with cert-manager on Kubernetes, AWS Certificate Manager on AWS, or your own certificate authority.
- Access to at least one model, whether a provider key set on the server, a key each user adds in the app, or a local endpoint such as Ollama or llama.cpp.
- `BETTER_AUTH_SECRET` to sign sessions, generated with `openssl rand -hex 32`. Compose and Kubernetes refuse to start without it. The AWS path does not: leave `betterAuthSecret` unset and it falls back to a fixed value published in this repository.
- `POWERSYNC_JWT_SECRET`, 32 characters or more, required once sync is turned on. The API and the sync service must be given the same value.

[Requirements](./requirements.md) has the detail behind each of these: sizing per service, database prerequisites, ports, and the outbound addresses to allow through a firewall.

The desktop and mobile apps are told which server to use when they are built, so pointing them at your deployment means producing your own builds. The browser app has no such constraint.

## Next

- [Requirements](./requirements.md): sizing, database, TLS, ports, and outbound access.
- [Configuration](./configuration.md): every setting and environment variable, with defaults.
- [Docker Compose](./docker-compose.md): one machine, one command.
- [Kubernetes](./kubernetes.md): the Helm chart, values, and upgrades.
- [AWS with Pulumi](./pulumi.md): Fargate or EKS, built from nothing.
