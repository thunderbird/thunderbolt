# Self-Hosting

> **Under active development.** Thunderbolt is undergoing a security audit and is not production-ready. Use these paths to evaluate it, not to serve real users yet.

Thunderbolt runs entirely on infrastructure you control. There is no vendor control plane to call home to. Traffic leaves your network to reach the AI providers you configure and a short list of feature endpoints, every one of which is listed in [Requirements](./requirements.md).

## Pick a deployment path

| Path                                  | What it takes                                                                                                            | How it scales                                                            | Good for                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| [Docker Compose](./docker-compose.md) | Docker on one machine, a config file, one command. The first run builds the images on that host and takes a few minutes. | One host, one copy of each service, no redundancy.                       | Demos, evaluation, a small internal tool, a test environment.           |
| [Kubernetes](./kubernetes.md)         | An existing cluster, an ingress controller, TLS, one `helm install`.                                                     | Set a replica count per service. Rolling upgrades through Helm.          | Teams that already run Kubernetes and have people who operate it.       |
| [AWS with Pulumi](./pulumi.md)        | An AWS account and the Pulumi CLI. Builds the network and compute from zero.                                             | Same as Kubernetes if you choose EKS; managed load balancing either way. | A green-field AWS deployment you want described as code from the start. |

The AWS path offers two targets from the same project: ECS Fargate (no cluster to operate) or EKS (which installs the same Helm chart Kubernetes users get).

If you are unsure, start with Docker Compose. The other paths run the same services and read the same settings, so what you learn transfers.

## What a deployment contains

| Piece                 | What it does                                                                                                  | Can you replace it?                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| The app               | The chat interface, served to a browser as a static site.                                                     | No.                                                            |
| The API               | Sign-in, authorizing each device for sync, link previews, web search, and the outbound calls to AI providers. | No.                                                            |
| The database          | PostgreSQL. Holds accounts, sessions, and the server-side copy of synced data.                                | On Docker Compose only. See the caveat below.                  |
| The sync service      | PowerSync. Keeps every signed-in device holding the same data, and streams changes as they happen.            | No, but it is part of the stack and needs no external service. |
| The identity provider | Keycloak, preloaded with a realm and a demo user, so sign-in works on first boot.                             | Yes, any OIDC or SAML identity provider.                       |

The Kubernetes and AWS paths also deploy a small static site (the landing page and these docs). Docker Compose does not, and on Kubernetes there is no switch to turn it off.

Each user's device keeps its own local database and reads and writes there first, so the app keeps working when your server is unreachable. Sync is how those local databases agree with each other, not where the app reads from.

**Caveat on a managed database.** On Docker Compose you can drop the bundled PostgreSQL and point `DATABASE_URL` at a managed service such as Amazon RDS, after creating the replication role and publication the sync service needs. The Kubernetes chart and the AWS project do not offer that: both always run the PostgreSQL they deploy.

Separately, the sync service keeps its own bookkeeping in a second database (`powersync_storage`) on the same server, and that piece is known to hang against RDS-managed PostgreSQL 17. Leave it on the PostgreSQL the deployment ships, or on an unmanaged instance.

## What you get by default

| Setting               | Default                                                                                                                                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in               | OIDC through the bundled Keycloak. SAML is also supported: switch `AUTH_MODE` to `saml` and supply your provider's details.                                                                                                |
| Identity realm        | `thunderbolt`, imported the first time Keycloak boots.                                                                                                                                                                     |
| Demo user             | `demo@thunderbolt.io` / `demo`                                                                                                                                                                                             |
| Keycloak admin        | `admin` / `admin` on Docker Compose and Kubernetes. The AWS path generates a random password unless you set one.                                                                                                           |
| Waitlist              | Off. Anyone your identity provider authenticates can sign in.                                                                                                                                                              |
| Analytics             | Off. Nothing is sent unless you configure an analytics service, and each user still has to opt in.                                                                                                                         |
| End-to-end encryption | Off. Turning on `E2EE_ENABLED` applies it to the whole deployment: message content is encrypted on the device, your servers hold only ciphertext, and each new device has to be approved from one the user already trusts. |

Every default credential above is published in this repository. Replace the demo user and rotate all of them before anyone outside your team reaches the deployment.

## Before you start

[Requirements](./requirements.md) has the detail behind this list: sizing per service, database prerequisites, ports, and the outbound addresses to allow through a firewall.

| You need                     | Notes                                                                                                                                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A host or cluster            | 4 GB RAM is the floor for the single-host path, 8 GB is comfortable.                                                                                                                      |
| A domain and DNS control     | Only for a shared deployment. Docker Compose on `localhost` needs neither.                                                                                                                |
| TLS certificates             | Anything other than `localhost` must be served over HTTPS. Issue them with cert-manager on Kubernetes, AWS Certificate Manager on AWS, or your own certificate authority.                 |
| Access to at least one model | A provider key set on the server, a key each user adds in the app, or a local endpoint such as Ollama or llama.cpp.                                                                       |
| A session secret             | `BETTER_AUTH_SECRET`, used to sign sessions. Generate with `openssl rand -hex 32`. Compose and Kubernetes refuse to start without it; the AWS path generates one if you do not supply it. |
| A sync secret                | `POWERSYNC_JWT_SECRET`, 32 characters or more, required once sync is turned on. The API and the sync service must be given the same value.                                                |

The desktop and mobile apps are told which server to use when they are built, so pointing them at your deployment means producing your own builds. The browser app has no such constraint.

## Next

- [Requirements](./requirements.md): sizing, database, TLS, ports, and outbound access.
- [Configuration](./configuration.md): every setting and environment variable, with defaults.
- [Docker Compose](./docker-compose.md): one machine, one command.
- [Kubernetes](./kubernetes.md): the Helm chart, values, and upgrades.
- [AWS with Pulumi](./pulumi.md): Fargate or EKS, built from nothing.
