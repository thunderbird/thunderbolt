# Pulumi (AWS)

`deploy/pulumi/` provisions the full Thunderbolt stack on AWS. The `platform` config key selects ECS Fargate or EKS; both create the VPC first and then branch, sharing one network and one set of pre-built images (`deploy/pulumi/index.ts:255-257`).

## Platforms

| `platform` value | What it creates                                                                                                                    | Best for                         |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `fargate`        | VPC, ECS Fargate, ALB, EFS, Cloud Map service discovery                                                                            | Serverless, no cluster to manage |
| `k8s`            | VPC, EKS cluster, EBS CSI driver with a default `gp3` StorageClass, nginx-ingress, and a Helm release of the chart in `deploy/k8s` | Teams who want Kubernetes on AWS |

Only the Fargate branch (`deploy/pulumi/index.ts:281-364`) creates the EFS filesystem, ALB and Cloudflare CNAMEs; the `k8s` branch (`:257-280`) creates the cluster and leaves persistence (EBS PVCs) and ingress to the chart.

## Setup

```bash
cd deploy/pulumi
bun install

pulumi stack init <stack-name>
pulumi config set aws:region us-east-1
pulumi config set platform fargate   # or k8s
pulumi config set version "$(jq -r .version ../../package.json)"   # image tag published to GHCR
pulumi config set --secret ghcrToken <github-pat>
pulumi config set --secret anthropicApiKey   $ANTHROPIC_API_KEY
pulumi config set --secret betterAuthSecret  $(openssl rand -hex 32)
pulumi config set --secret powersyncJwtSecret $(openssl rand -hex 32)
```

`config.require('version')` (`deploy/pulumi/index.ts:22`) aborts the preview when `version` is unset. `ghcrToken` is a GitHub PAT for pulling images from GHCR.

## Deploy

```bash
pulumi up
```

Nothing is built here. Images come from `ghcr.io/thunderbird/thunderbolt/thunderbolt-{frontend,backend,postgres,keycloak,powersync,marketing}:<version>` (`deploy/pulumi/index.ts:202-211`), published by `.github/workflows/images-publish.yml`; a new build means bumping `version`.

| Platform  | Exports                                                                                                          |
| --------- | ---------------------------------------------------------------------------------------------------------------- |
| `fargate` | `url` (marketing hostname under subdomain routing, else the raw ALB DNS name), `urls`, `albDnsName` (`:353-361`) |
| `k8s`     | `kubeconfig` and a `note` only (`:272-280`); read the address off the ingress controller (below)                |

```bash
kubectl get svc -n ingress-nginx ingress-nginx-controller \
  -o jsonpath="{.status.loadBalancer.ingress[0].hostname}"
```

## Destroy

```bash
pulumi destroy -y
pulumi stack rm <stack-name> -y
```

## Project Layout

```text
deploy/pulumi/
  index.ts            # Entry point: branches on platform config and stack shape
  src/
    vpc.ts            # VPC, subnets, NAT gateway, security groups (both platforms)
    # Fargate-specific:
    cluster.ts        # ECS cluster + CloudWatch log group
    services.ts       # Fargate task definitions + services
    alb.ts            # ALB + host- and path-based routing rules
    discovery.ts      # Cloud Map service discovery
    storage.ts        # EFS filesystem + Postgres access point (uid 70)
    dns.ts            # Cloudflare CNAMEs pointing the stack's hostnames at the ALB
    # Preview stacks:
    shared.ts         # Long-lived `previews-shared` stack: VPC/ALB/postgres/keycloak/powersync
    per-pr-stack.ts   # Slim `preview-pr-<n>` stack: app services only, shared infra via StackReference
    # Kubernetes-specific:
    eks.ts            # EKS cluster, EBS CSI + gp3 StorageClass, Helm release of deploy/k8s, nginx-ingress
```

`index.ts` picks one of three shapes: the shared preview stack (`previews-shared`), a per-PR stack reading it through a `StackReference` when `sharedStackName` is set, or the monolithic stack every other name uses (including enterprise deployments).

## CI

The `Stack Deploy` workflow (`.github/workflows/stack-deploy.yml`) wraps `pulumi up` for repeatable deploys. Its inputs:

| Input                           | Notes                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| `action`                        | `deploy` or `destroy` (required)                                                      |
| `stack_name`                    | Pulumi stack, e.g. `demo-acme` (required)                                             |
| `platform`                      | `fargate` (default) or `k8s`                                                          |
| `region`                        | `us-east-1` (default), `us-west-2`, or `eu-west-1`                                    |
| `version`                       | Image tag; falls back to the root `package.json` version (`stack-deploy.yml:155-164`) |
| `marketing_hostname`            | One hostname per service: marketing, app, API, Keycloak, PowerSync                    |
| `app_hostname`                  |                                                                                       |
| `api_hostname`                  |                                                                                       |
| `auth_hostname`                 |                                                                                       |
| `powersync_hostname`            |                                                                                       |
| `cloudflare_zone_id`            | Required whenever any hostname is set                                                 |
| `thunderbolt_inference_url`     | Inference gateway URL (non-secret, passed as plain config)                            |
| `confidential_api_keys_enabled` | Lets a personal access token reach the confidential (Tinfoil) routes                  |
| `shared_stack_name`             | Switches a per-PR deploy into shared-stack mode                                       |

Any hostname turns on subdomain routing: a proxied Cloudflare CNAME per hostname, with its public URL wired into each container, instead of one raw ALB hostname with path-based routing. The program throws when a hostname is set without a zone ID and API token (`deploy/pulumi/index.ts:180-185`).

Secrets, all optional (a minimal enterprise deploy needs only the first three): `PULUMI_ACCESS_TOKEN`, `AWS_DEPLOY_ROLE_ARN`, `GHCR_PAT`, `CLOUDFLARE_API_TOKEN`, `ANTHROPIC_API_KEY`, `FIREWORKS_API_KEY`, `THUNDERBOLT_INFERENCE_API_KEY`, `TINFOIL_API_KEY`, `TINFOIL_ENCLAVE_URL`, `EXA_API_KEY` (resolved from the `preview` GitHub environment, not passed by callers). No `PULUMI_CONFIG_PASSPHRASE`: the workflow authenticates with `PULUMI_ACCESS_TOKEN` alone and `Pulumi.yaml` declares no secrets provider, so config and state use Pulumi Cloud's managed key.

## Notes

- **EFS for Postgres on Fargate.** Persistence is EFS, not RDS, which keeps everything in one project; swap to RDS yourself if you need it. The access point pins uid/gid 70 on `/postgres-data` to match the Postgres image's system user (`deploy/pulumi/src/storage.ts:30-41`), so a major-version bump that changes that uid needs the data chowned first.
- **PersistentVolumeClaims on EKS.** The chart's Postgres StatefulSet names no storage class (`deploy/k8s/templates/postgres.yaml:76-83`), so PVCs land on the cluster default: the `gp3` class `eks.ts` installs over the EBS CSI driver (`deploy/pulumi/src/eks.ts:95-114`).
- **Keycloak hostname.** Fargate sets `KC_HOSTNAME` to the auth service's public URL and trusts `X-Forwarded-Proto` from the ALB/Cloudflare, so Keycloak 26 derives both frontchannel and backchannel URLs (`deploy/pulumi/src/services.ts:325-330`). The Helm chart sets `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true` instead (`deploy/k8s/templates/keycloak.yaml:46-47`).

## Switching Platforms Mid-Stack

`pulumi config set platform k8s` then `pulumi up` destroys the ECS resources and spins up the EKS cluster, reusing the VPC (created before the platform branch).

The database does not come with it: `createStorage` runs only in the Fargate branch (`deploy/pulumi/index.ts:283`), so the EFS filesystem holding `/postgres-data` is destroyed and the chart starts from an empty PVC. Dump anything you want to keep first.
