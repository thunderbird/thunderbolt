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

| Platform | Creates | Persistence | Best For |
|----------|---------|-------------|----------|
| `fargate` | VPC, ECS, ALB, EFS, Cloud Map | EFS | Serverless |
| `k8s` | VPC, EKS, EBS CSI, nginx-ingress | EBS gp3 PVCs | Kubernetes teams |

## Project Structure

```
index.ts              # Entry point — branches on platform config
src/
  vpc.ts              # VPC, subnets, NAT, security groups (shared)
  # Fargate
  cluster.ts          # ECS cluster + CloudWatch logs
  services.ts         # 6 Fargate task definitions
  alb.ts              # ALB + path-based routing
  storage.ts          # EFS + access points
  discovery.ts        # Cloud Map DNS (thunderbolt.local)
  # EKS
  eks.ts              # EKS cluster, EBS CSI, Helm chart, nginx-ingress
```

## Required Secrets (GitHub Actions)

| Secret | Description |
|--------|-------------|
| `AWS_DEPLOY_ROLE_ARN` | IAM role for OIDC-based AWS auth |
| `PULUMI_ACCESS_TOKEN` | Pulumi Cloud API token |
| `PULUMI_CONFIG_PASSPHRASE` | Stack config encryption passphrase |
| `GHCR_PAT` | GitHub PAT for pulling private images |
