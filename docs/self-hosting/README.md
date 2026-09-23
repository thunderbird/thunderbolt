# Self-Hosting

> ⚠️ Thunderbolt is undergoing a security audit and is **not production-ready**. The paths below are for evaluation and early testing.

Every target runs the same stack: Elysia backend, Vite frontend, PostgreSQL, PowerSync, and Keycloak (OIDC/SAML). PowerSync keeps its bucket storage in a second database (`powersync_storage`) on the same Postgres, so there is no extra datastore. Only the orchestration layer differs.

## Which Option Should I Pick?

| Target         | What it creates                                                                                                | Best for                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Docker Compose | Single-host stack; all services in containers on one machine                                                   | Demos, evaluations, small internal tools, CI             |
| Kubernetes     | Helm chart in `deploy/k8s/`: Postgres, PowerSync, Keycloak, backend, frontend, ingress from one `helm install` | Production, existing clusters, teams with platform folks |
| Pulumi (AWS)   | VPC, ECR image builds, and **either** ECS Fargate **or** EKS depending on the `platform` config                | Green-field AWS deployments using infrastructure-as-code |

All paths build the backend and frontend images from the same Dockerfiles in `deploy/docker/`, but the supporting config is **not** shared. Docker Compose and Pulumi/Fargate read sync rules and the Keycloak realm from `deploy/config/` (`powersync-config.yaml`, `keycloak-realm.json`); the Helm chart carries inlined copies in `deploy/k8s/templates/configmaps.yaml`. Change either one in both places (see the [sync-rule config list](../architecture/powersync-account-devices.md#adding-a-new-synced-table)).

## The Enterprise Defaults

All three paths deploy the same defaults:

| Setting             | Value                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Auth mode           | OIDC via Keycloak (SAML also supported, set `AUTH_MODE=saml`)                                                    |
| Keycloak realm      | `thunderbolt`, imported on first boot (Compose reads `deploy/config/keycloak-realm.json`; Helm its inlined copy) |
| Default demo user   | `demo@thunderbolt.io` / `demo`                                                                                   |
| Keycloak admin      | `admin` / `admin` (change immediately)                                                                           |
| Frontend build args | `VITE_AUTH_MODE=sso`, `VITE_THUNDERBOLT_CLOUD_URL=/v1`                                                           |
| Waitlist            | Disabled                                                                                                         |

Replace the demo user, reconfigure the Keycloak client, and rotate every default credential before anyone touches it.

## What You'll Need

- A domain and DNS control (for production)
- TLS certificates: cert-manager on Kubernetes, ACM for AWS, or your own
- At least one AI provider API key
- `BETTER_AUTH_SECRET`: any 32+ character random string
- `POWERSYNC_JWT_SECRET`: 32+ characters, must match the value in the PowerSync config

Every environment variable is in the [Configuration Reference](./configuration.md).

## Next

- [Docker Compose](./docker-compose.md)
- [Kubernetes](./kubernetes.md)
- [Pulumi (AWS)](./pulumi.md)
