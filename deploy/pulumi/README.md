# Thunderbolt Pulumi (AWS)

Infrastructure as Code for deploying Thunderbolt to AWS. Supports two platforms from the same project.

## Platforms

| Platform | What it creates | Best for |
|----------|----------------|----------|
| `fargate` | VPC, ECS Fargate, ALB, ECR, EFS, Cloud Map | Serverless, no cluster management |
| `k8s` | VPC, EKS cluster, nginx-ingress, ECR, k8s manifests | Clients who want Kubernetes |

Both platforms share VPC and ECR image builds. The `platform` config controls which compute layer is provisioned.

## Setup

```bash
cd deploy/pulumi
bun install
pulumi stack init <stack-name>
pulumi config set aws:region us-east-1
pulumi config set platform fargate   # or k8s
```

## Deploy

```bash
pulumi up
```

Outputs include the public URL, and for k8s, the kubeconfig.

## Destroy

```bash
pulumi destroy -y
pulumi stack rm <stack-name> -y
```

## Project Structure

```
pulumi/
  index.ts          # Entry point — branches on platform config
  src/
    vpc.ts          # VPC, subnets, NAT gateway, security groups
    ecr.ts          # ECR repos + Docker image builds
    # Fargate-specific:
    cluster.ts      # ECS cluster + CloudWatch log group
    services.ts     # 6 Fargate task definitions + services
    alb.ts          # ALB + path-based routing rules
    discovery.ts    # Cloud Map service discovery
    storage.ts      # EFS for Postgres + MongoDB persistence
    # Kubernetes-specific:
    eks.ts          # EKS cluster, nginx-ingress, k8s manifest deployment
```

## GitHub Actions

The `Enterprise Deploy` workflow (`.github/workflows/enterprise-deploy.yml`) triggers deployment with inputs:

- **action**: deploy or destroy
- **platform**: fargate or k8s
- **region**: us-east-1, us-west-2, eu-west-1
- **stack_name**: e.g., `demo-acme`

Required secrets: `AWS_DEPLOY_ROLE_ARN`, `PULUMI_ACCESS_TOKEN`, `PULUMI_CONFIG_PASSPHRASE`

## Notes

- ECR images are built and pushed as part of `pulumi up` — no separate build step
- Fargate uses EFS for database persistence (not RDS)
- EKS uses PersistentVolumeClaims via the default storage class
- Keycloak uses `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true` for OIDC in both platforms
