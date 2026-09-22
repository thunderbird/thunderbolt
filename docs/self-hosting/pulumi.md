# Pulumi (AWS)

The Pulumi project at `deploy/pulumi/` provisions the full Thunderbolt stack on AWS. One config key (`platform`) chooses between ECS Fargate and EKS; both paths create the VPC first and then branch, so they share one network and one set of pre-built images (`deploy/pulumi/index.ts:255-257`).

## Platforms

| `platform` value | What it creates                                                                                                                    | Best for                          |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `fargate`        | VPC, ECS Fargate, ALB, EFS, Cloud Map service discovery                                                                            | Serverless — no cluster to manage |
| `k8s`            | VPC, EKS cluster, EBS CSI driver with a default `gp3` StorageClass, nginx-ingress, and a Helm release of the chart in `deploy/k8s` | Teams who want Kubernetes on AWS  |

`platform` swaps more than compute. The Fargate branch (`deploy/pulumi/index.ts:281-364`) is the only one that creates the EFS filesystem, the ALB and the Cloudflare CNAMEs; the `k8s` branch (`:257-280`) creates the cluster and hands everything else to the chart — persistence to EBS-backed PVCs, ingress to nginx-ingress.

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

`version` has no default: `config.require('version')` (`deploy/pulumi/index.ts:22`) aborts the preview when it is unset. `ghcrToken` is a GitHub PAT used to pull the images from GHCR.

## Deploy

```bash
pulumi up
```

Nothing is built during `pulumi up`. Every image is pulled from `ghcr.io/thunderbird/thunderbolt/thunderbolt-{frontend,backend,postgres,keycloak,powersync,marketing}:<version>` (`deploy/pulumi/index.ts:202-211`); the images themselves are built and published separately by `.github/workflows/images-publish.yml`, so deploying a new build means bumping `version` rather than rebuilding here.

The two platforms export different outputs. Fargate gives you `url` — the marketing public URL, which is the marketing hostname under subdomain routing and the raw ALB DNS name otherwise — plus per-service `urls` and `albDnsName` (`deploy/pulumi/index.ts:353-361`). The `k8s` path exports no URL at all, only `kubeconfig` and a `note` telling you to read the address off the ingress controller (`deploy/pulumi/index.ts:272-280`):

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
  index.ts            # Entry point — branches on platform config and stack shape
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
    shared.ts         # Long-lived `previews-shared` stack — VPC/ALB/postgres/keycloak/powersync
    per-pr-stack.ts   # Slim `preview-pr-<n>` stack — app services only, shared infra via StackReference
    # Kubernetes-specific:
    eks.ts            # EKS cluster, EBS CSI + gp3 StorageClass, Helm release of deploy/k8s, nginx-ingress
```

`index.ts` picks one of three shapes: the shared preview stack (`previews-shared`), a per-PR stack that reads it through a `StackReference` when `sharedStackName` is set, or the monolithic stack every other stack name uses — including enterprise deployments.

## CI

The `Stack Deploy` workflow at `.github/workflows/stack-deploy.yml` wraps `pulumi up` for repeatable deploys. Its inputs:

| Input                           | Notes                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| `action`                        | `deploy` or `destroy` (required)                                                      |
| `stack_name`                    | Pulumi stack, e.g. `demo-acme` (required)                                             |
| `platform`                      | `fargate` (default) or `k8s`                                                          |
| `region`                        | `us-east-1` (default), `us-west-2`, or `eu-west-1`                                    |
| `version`                       | Image tag; falls back to the root `package.json` version (`stack-deploy.yml:155-164`) |
| `marketing_hostname`            | One hostname per service — marketing, app, API, Keycloak, PowerSync                   |
| `app_hostname`                  |                                                                                       |
| `api_hostname`                  |                                                                                       |
| `auth_hostname`                 |                                                                                       |
| `powersync_hostname`            |                                                                                       |
| `cloudflare_zone_id`            | Required whenever any hostname is set                                                 |
| `thunderbolt_inference_url`     | Inference gateway URL (non-secret, passed as plain config)                            |
| `confidential_api_keys_enabled` | Lets a personal access token reach the confidential (Tinfoil) routes                  |
| `shared_stack_name`             | Switches a per-PR deploy into shared-stack mode                                       |

Setting any hostname turns on subdomain routing: Pulumi creates a proxied Cloudflare CNAME per hostname and wires the matching public URL into each container, instead of sharing one raw ALB hostname with path-based routing. That is why `cloudflare_zone_id` becomes mandatory — the program throws when a hostname is set without a zone ID and API token (`deploy/pulumi/index.ts:180-185`).

Secrets, all declared optional so a minimal enterprise deploy needs only the first three: `PULUMI_ACCESS_TOKEN`, `AWS_DEPLOY_ROLE_ARN`, `GHCR_PAT`, `CLOUDFLARE_API_TOKEN`, `ANTHROPIC_API_KEY`, `FIREWORKS_API_KEY`, `THUNDERBOLT_INFERENCE_API_KEY`, `TINFOIL_API_KEY`, `TINFOIL_ENCLAVE_URL`, and `EXA_API_KEY` (resolved from the `preview` GitHub environment rather than passed by callers). There is no `PULUMI_CONFIG_PASSPHRASE`: the workflow authenticates with `PULUMI_ACCESS_TOKEN` alone and `Pulumi.yaml` declares no secrets provider, so stack config and state are encrypted by Pulumi Cloud's managed key.

## Notes

- **EFS for Postgres on Fargate** — the Fargate path uses EFS for database persistence rather than RDS. This keeps everything inside one project; swap to RDS yourself if you need it. The EFS access point pins uid/gid 70 on `/postgres-data` to match the Postgres image's system user (`deploy/pulumi/src/storage.ts:30-41`), so a Postgres major-version bump that changes that uid needs the existing data chowned first.
- **PersistentVolumeClaims on EKS** — the chart's Postgres StatefulSet names no storage class (`deploy/k8s/templates/postgres.yaml:76-83`), so PVCs land on the cluster default, which `eks.ts` installs as a `gp3` class backed by the EBS CSI driver (`deploy/pulumi/src/eks.ts:95-114`).
- **Keycloak hostname** — the two platforms get there differently. Fargate sets `KC_HOSTNAME` to the auth service's public URL and trusts `X-Forwarded-Proto` from the ALB/Cloudflare, letting Keycloak 26 derive both frontchannel and backchannel URLs from it (`deploy/pulumi/src/services.ts:325-330`); the Helm chart sets `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true` instead (`deploy/k8s/templates/keycloak.yaml:46-47`).

## Switching Platforms Mid-Stack

You can stand up Fargate, try it, then migrate to EKS without tearing down the VPC — `pulumi config set platform k8s` and `pulumi up`. Pulumi destroys the ECS resources and spins up the EKS cluster, reusing the VPC, which is created before the platform branch.

The database does not come with it. `createStorage` is called only inside the Fargate branch (`deploy/pulumi/index.ts:283`), so switching to `k8s` destroys the EFS filesystem holding `/postgres-data` and the chart starts from an empty PVC. Dump anything you want to keep before the switch.
