# Thunderbolt Pulumi (AWS)

Infrastructure as Code for deploying Thunderbolt to AWS. Supports Fargate and EKS from the same project.

For full documentation including CI/CD workflows and troubleshooting, see the [main deployment guide](../README.md#3-aws-with-pulumi).

## Quick Start

```bash
bun install
pulumi stack init dev
pulumi config set aws:region us-east-1
pulumi config set platform fargate         # or k8s
pulumi config set version 0.1.85           # image version from GHCR
pulumi config set --secret ghcrToken <pat> # GitHub PAT for private images
pulumi up
```

## Platforms

| Platform  | Creates                          | Persistence  | Best For         |
| --------- | -------------------------------- | ------------ | ---------------- |
| `fargate` | VPC, ECS, ALB, EFS, Cloud Map    | EFS          | Serverless       |
| `k8s`     | VPC, EKS, EBS CSI, nginx-ingress | EBS gp3 PVCs | Kubernetes teams |

## Project Structure

```
index.ts              # Entry point — branches on platform config and stack shape
src/
  vpc.ts              # VPC, subnets, NAT, security groups (shared)
  # Fargate
  cluster.ts          # ECS cluster + CloudWatch logs
  services.ts         # 6 Fargate task definitions
  alb.ts              # ALB + path-based routing
  storage.ts          # EFS + access points
  discovery.ts        # Cloud Map DNS (thunderbolt.local)
  dns.ts              # Cloudflare CNAMEs for the stack's hostnames
  # Preview stacks
  shared.ts           # `previews-shared` stack — long-lived VPC/ALB/postgres/keycloak/powersync
  per-pr-stack.ts     # Slim `preview-pr-<n>` stack — app services only, shared infra via StackReference
  # EKS
  eks.ts              # EKS cluster, EBS CSI, Helm chart, nginx-ingress
```

`index.ts` picks one of three shapes: the shared preview stack, a per-PR stack that
reads it through a `StackReference` (when `sharedStackName` is set), or the monolithic
stack every other stack name still uses.

## Required Secrets (GitHub Actions)

| Secret                | Description                           |
| --------------------- | ------------------------------------- |
| `AWS_DEPLOY_ROLE_ARN` | IAM role for OIDC-based AWS auth      |
| `PULUMI_ACCESS_TOKEN` | Pulumi Cloud API token                |
| `GHCR_PAT`            | GitHub PAT for pulling private images |

Stack config and state are encrypted by Pulumi Cloud, which `PULUMI_ACCESS_TOKEN`
authenticates against — there is no local secrets provider and no passphrase to set.
