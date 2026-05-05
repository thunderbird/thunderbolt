# Self-Hosting

> ⚠️ Thunderbolt is currently undergoing a security audit and preparing for enterprise production readiness. The paths below are provided for evaluation and early testing — **not for production use yet**.

> 🚨 **Read [Default Credentials](../../deploy/README.md#default-credentials) before deploying.** Every path here ships with public, well-known default values for database passwords, OIDC client secrets, JWT signing keys, and the Keycloak admin password. The stack will deploy and run with them — and warn loudly across multiple surfaces (Pulumi log, backend stderr, browser DevTools, frontend container logs) — but the only fix is to rotate them. The override commands per platform are in that section.

Every self-hosted target uses the same stack: Elysia backend, Vite frontend, PostgreSQL, PowerSync, Keycloak (OIDC/SAML), and MongoDB (PowerSync's operational store). What changes is the orchestration layer.

## Which Option Should I Pick?

| Target            | What it creates                                                                                   | Best for                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Docker Compose    | Single-host stack — all services run in containers on one machine                                 | Demos, evaluations, small internal tools, CI               |
| Kubernetes        | Manifests + `up.sh`/`down.sh` scripts; ConfigMaps synthesized from `deploy/config/`               | Production, existing clusters, teams with platform folks   |
| Pulumi (AWS)      | VPC, ECR image builds, and **either** ECS Fargate **or** EKS depending on the `platform` config   | Green-field AWS deployments using infrastructure-as-code   |

All three paths share the `deploy/docker/` Dockerfiles and the realm / sync-rule configs in `deploy/config/`. There's no duplication — the k8s manifests pull the same Postgres init SQL from `powersync-service/init-db/`, the same PowerSync config from `deploy/config/powersync-config.yaml`, and the same Keycloak realm from `deploy/config/keycloak-realm.json`.

## The Enterprise Defaults

All three paths deploy the same opinionated enterprise configuration:

| Setting                       | Value                                                     |
| ----------------------------- | --------------------------------------------------------- |
| Auth mode                     | OIDC via Keycloak (SAML also supported — set `AUTH_MODE=saml`) |
| Keycloak realm                | `thunderbolt` (auto-imported from `deploy/config/keycloak-realm.json`) |
| Default demo user             | `demo@thunderbolt.so` / `demo`                            |
| Keycloak admin                | `admin` / `admin` (change immediately)                    |
| Frontend build args           | `VITE_AUTH_MODE=sso`, `VITE_THUNDERBOLT_CLOUD_URL=/v1`    |
| Waitlist                      | Disabled                                                  |

You're expected to replace the demo user, reconfigure the Keycloak client, and rotate all default credentials before anyone touches it. The full table of public-default values + per-platform override commands is in [`deploy/README.md`](../../deploy/README.md#default-credentials), and is the canonical source — every warning surface (Pulumi, backend, DevTools, container entrypoint) reads from the same machine-readable list at [`shared/insecure-defaults.ts`](../../shared/insecure-defaults.ts).

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
