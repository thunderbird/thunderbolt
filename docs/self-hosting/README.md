# Self-Hosting

> ⚠️ Thunderbolt is currently undergoing a security audit and preparing for enterprise production readiness. The paths below are provided for evaluation and early testing — **not for production use yet**.

Every self-hosted target uses the same stack: Elysia backend, Vite frontend, PostgreSQL, PowerSync, and Keycloak (OIDC/SAML). PowerSync keeps its own bucket storage in a second database (`powersync_storage`) on the same Postgres, so there is no extra datastore to run. What changes is the orchestration layer.

## Which Option Should I Pick?

| Target         | What it creates                                                                                                    | Best for                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| Docker Compose | Single-host stack — all services run in containers on one machine                                                  | Demos, evaluations, small internal tools, CI             |
| Kubernetes     | Helm chart in `deploy/k8s/` — Postgres, PowerSync, Keycloak, backend, frontend and ingress from one `helm install` | Production, existing clusters, teams with platform folks |
| Pulumi (AWS)   | VPC, ECR image builds, and **either** ECS Fargate **or** EKS depending on the `platform` config                    | Green-field AWS deployments using infrastructure-as-code |

The backend and frontend images every path runs are built from the same Dockerfiles in `deploy/docker/`. The supporting configuration is **not** shared between all three: Docker Compose and the Pulumi/Fargate path read the sync rules and Keycloak realm from `deploy/config/` (`powersync-config.yaml`, `keycloak-realm.json`), while the Helm chart carries its own inlined copies in `deploy/k8s/templates/configmaps.yaml`. A change to the sync rules or the realm has to be applied in both places — see the [sync-rule config list](../architecture/powersync-account-devices.md#adding-a-new-synced-table).

## The Enterprise Defaults

All three paths deploy the same opinionated enterprise configuration:

| Setting             | Value                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Auth mode           | OIDC via Keycloak (SAML also supported — set `AUTH_MODE=saml`)                                                   |
| Keycloak realm      | `thunderbolt`, imported on first boot (Compose reads `deploy/config/keycloak-realm.json`; Helm its inlined copy) |
| Default demo user   | `demo@thunderbolt.io` / `demo`                                                                                   |
| Keycloak admin      | `admin` / `admin` (change immediately)                                                                           |
| Frontend build args | `VITE_AUTH_MODE=sso`, `VITE_THUNDERBOLT_CLOUD_URL=/v1`                                                           |
| Waitlist            | Disabled                                                                                                         |

You're expected to replace the demo user, reconfigure the Keycloak client, and rotate all default credentials before anyone touches it.

## What You'll Need

- A domain and DNS control (for production)
- TLS certificates — cert-manager on Kubernetes, ACM for AWS, or bring your own
- At least one AI provider API key
- A `BETTER_AUTH_SECRET` — any 32+ character random string
- A `POWERSYNC_JWT_SECRET` — 32+ characters; must match the one in the PowerSync config

See the [Configuration Reference](./configuration.md) for every environment variable.

## Next

- [Docker Compose](./docker-compose.md)
- [Kubernetes](./kubernetes.md)
- [Pulumi (AWS)](./pulumi.md)
