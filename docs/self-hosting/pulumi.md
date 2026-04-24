# Pulumi (AWS)

The Pulumi project at `deploy/pulumi/` provisions the full Thunderbolt stack on AWS. One config key (`platform`) chooses between ECS Fargate and EKS; both paths share the same VPC, ECR repositories, and secrets.

## Platforms

| `platform` value | What it creates                                                | Best for                                          |
| ---------------- | -------------------------------------------------------------- | ------------------------------------------------- |
| `fargate`        | VPC, ECS Fargate, ALB, ECR, EFS, Cloud Map service discovery   | Serverless — no cluster to manage                 |
| `k8s`            | VPC, EKS cluster, nginx-ingress, ECR, and the k8s manifests    | Teams who want Kubernetes on AWS                  |

Both paths share the VPC and ECR image builds. The `platform` flag switches only the compute layer.

## Setup

```bash
cd deploy/pulumi
bun install

pulumi stack init <stack-name>
pulumi config set aws:region us-east-1
pulumi config set platform fargate   # or k8s
pulumi config set --secret anthropicApiKey   $ANTHROPIC_API_KEY
pulumi config set --secret betterAuthSecret  $(openssl rand -hex 32)
pulumi config set --secret powersyncJwtSecret $(openssl rand -hex 32)
```

## Deploy

```bash
pulumi up
```

ECR images are built and pushed as part of `pulumi up` — no separate build step. Outputs include the public URL (ALB DNS) and, for `k8s`, a kubeconfig you can merge into `~/.kube/config`.

## Destroy

```bash
pulumi destroy -y
pulumi stack rm <stack-name> -y
```

## Project Layout

```
deploy/pulumi/
  index.ts            # Entry point — branches on platform config
  src/
    vpc.ts            # VPC, subnets, NAT gateway, security groups
    ecr.ts            # ECR repositories + Docker image builds
    # Fargate-specific:
    cluster.ts        # ECS cluster + CloudWatch log group
    services.ts       # Fargate task definitions + services
    alb.ts            # ALB + path-based routing rules
    discovery.ts      # Cloud Map service discovery
    storage.ts        # EFS for Postgres + MongoDB persistence
    # Kubernetes-specific:
    eks.ts            # EKS cluster, nginx-ingress, manifest deployment
```

## CI

The `Enterprise Deploy` workflow at `.github/workflows/enterprise-deploy.yml` wraps `pulumi up` for repeatable deploys. Inputs:

- `action` — `deploy` or `destroy`
- `platform` — `fargate` or `k8s`
- `region` — `us-east-1`, `us-west-2`, or `eu-west-1`
- `stack_name` — e.g. `demo-acme`

Required secrets: `AWS_DEPLOY_ROLE_ARN`, `PULUMI_ACCESS_TOKEN`, `PULUMI_CONFIG_PASSPHRASE`.

## Notes

- **EFS for Postgres on Fargate** — the Fargate path uses EFS for database persistence rather than RDS. This keeps everything inside one project; swap to RDS yourself if you need it.
- **PersistentVolumeClaims on EKS** — the EKS path uses the cluster's default storage class for PVCs.
- **Keycloak backchannel** — both platforms set `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true` so OIDC works against the ALB/ingress hostname.

## Switching Platforms Mid-Stack

You can stand up Fargate, try it, then migrate to EKS without tearing down the VPC — just `pulumi config set platform k8s` and `pulumi up`. Pulumi destroys the ECS resources and spins up the EKS cluster, reusing the VPC and ECR.
