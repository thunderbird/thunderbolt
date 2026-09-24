# AWS with Pulumi

Thunderbolt ships an infrastructure-as-code project that builds a complete deployment in an empty AWS account: network, compute, load balancing, storage, and DNS. You choose one of two compute targets, and everything else is shared.

Use this path when you want the whole deployment described as code from the start. If you already run Kubernetes somewhere, the [Kubernetes](./kubernetes.md) path installs the same software into your existing cluster.

## Choose a target

| Target          | Setting value | What runs the containers                           | Storage for the database  | Good for                                          |
| --------------- | ------------- | -------------------------------------------------- | ------------------------- | ------------------------------------------------- |
| **ECS Fargate** | `fargate`     | AWS-managed containers, no cluster to operate      | EFS volume                | The default. No Kubernetes knowledge needed.      |
| **EKS**         | `k8s`         | A managed Kubernetes cluster with two worker nodes | EBS volumes (`gp3` class) | Teams who want Kubernetes and already operate it. |

On EKS the project creates the cluster and then installs the Helm chart documented on the [Kubernetes](./kubernetes.md) page, which is the reference for everything after the cluster exists: chart values, hostnames, TLS, credentials, and upgrades. Only a handful of the settings on this page reach an EKS deployment. Region, target, version, the registry token, the session secret, and the public address get through; the rest configure Fargate services directly and are ignored there, so set their Helm equivalents instead.

## What gets created

Both targets get the same network: a VPC on `10.0.0.0/16` across two availability zones, with public and private subnets. One NAT gateway sits in the first public subnet. The security groups admit public HTTP and HTTPS into the load balancer, and the load balancer into the services.

Fargate adds an ECS cluster, one task per service, an Application Load Balancer, internal service discovery so the services can find each other by name, an EFS filesystem for the database, CloudWatch logs with 7-day retention, and AWS Secrets Manager entries for the database, session, sync, and AI provider credentials.

EKS adds the cluster (two `t3.medium` nodes, in a group sized between one and three), the EBS CSI driver with `gp3` as the default storage class, an nginx ingress controller, and the Thunderbolt Helm release.

Six services run either way: the app, the API, PostgreSQL, the sync service, Keycloak, and the marketing and docs site.

### Fargate sizing

Each service runs a single copy with no standby, and the six together come to 4 vCPU and 8 GB running continuously.

| Service      | vCPU | Memory |
| ------------ | ---- | ------ |
| API          | 1    | 2 GB   |
| PostgreSQL   | 1    | 2 GB   |
| Keycloak     | 1    | 2 GB   |
| Sync service | 0.5  | 1 GB   |
| App          | 0.25 | 0.5 GB |
| Marketing    | 0.25 | 0.5 GB |

## Before you start

You need an AWS account, with credentials the Pulumi CLI can use, for example through `aws sso login` or an access key. You also need the Pulumi CLI itself and a Pulumi Cloud account, which is where state and secrets are encrypted, so there is no passphrase to manage. Bun installs the project's dependencies. The deployment installs published images and builds nothing, so you must also name an image version that exists.

Two of the prerequisites are conditional. A Cloudflare zone applies only if you want real hostnames and TLS on Fargate (see [Hostnames and TLS](#hostnames-and-tls)). The published images are public, so a GitHub token with package read access is needed only if you have restricted them.

## Deploy

```bash
cd deploy/pulumi
bun install

pulumi stack init acme-prod
pulumi config set aws:region us-east-1
pulumi config set platform fargate                        # or k8s
pulumi config set version 0.1.133                         # a published image tag
pulumi config set --secret betterAuthSecret "$(openssl rand -hex 32)"
pulumi config set --secret powersyncJwtSecret "$(openssl rand -hex 32)"
pulumi config set --secret postgresPassword "$(openssl rand -hex 24)"
pulumi config set --secret powersyncDbPassword "$(openssl rand -hex 24)"
pulumi config set --secret keycloakAdminPassword "$(openssl rand -hex 24)"
pulumi config set --secret oidcClientSecret "$(openssl rand -hex 24)"
pulumi config set --secret anthropicApiKey <key>          # or another provider

pulumi up
```

`version` has no default and the preview fails without it. Images are published for every release under `ghcr.io/thunderbird/thunderbolt/`, so the `version` you set must match a tag that exists there. Upgrading later means setting a new `version` and running `pulumi up` again. The stack name is yours to pick, with two reservations. Names beginning with `preview-`, and the name `previews-shared`, are used by the project's own pull-request environments and behave differently.

### Getting the address

On Fargate, the stack reports a `url` (your hostname if you configured one, otherwise the load balancer's own address) along with a `urls` list and the load balancer's DNS name. Read them with `pulumi stack output`.

On EKS the stack reports only a kubeconfig, because the address belongs to the ingress controller:

```bash
kubectl get svc -n ingress-nginx ingress-nginx-controller \
  -o jsonpath="{.status.loadBalancer.ingress[0].hostname}"
```

### Rotate the defaults

**Every credential you leave unset falls back to a fixed value published in this repository**, and nothing is generated for you. Set all six as secrets before anyone outside your team can reach the deployment:

| Setting                 | Default if unset                      |
| ----------------------- | ------------------------------------- |
| `keycloakAdminPassword` | `admin`, against the username `admin` |
| `postgresPassword`      | `postgres`                            |
| `powersyncDbPassword`   | A published fixed string              |
| `oidcClientSecret`      | A published fixed string              |
| `betterAuthSecret`      | A published fixed string              |
| `powersyncJwtSecret`    | A published fixed string              |

Keycloak also imports a demo user, `demo@thunderbolt.io` / `demo`, exactly as on the other deployment paths. Remove it in the Keycloak admin console once your own identity provider or users are in place.

On EKS these settings are not passed through to the cluster. The chart applies its own defaults, which are published too and covered on the [Kubernetes](./kubernetes.md) page.

## Hostnames and TLS

This section applies to the Fargate target only. By default the load balancer answers on its own AWS address over plain HTTP, and requests are routed by path: `/v1/` to the API, `/auth/` and `/realms/` to Keycloak, `/powersync/` to the sync service, everything else to the app. The marketing and docs site has no path of its own and is unreachable in this mode. That is enough to evaluate the deployment, and not enough to serve users.

Setting any hostname switches the deployment to one subdomain per service, routed by the host name in the request:

```bash
pulumi config set marketingHostname  thunderbolt.example.com
pulumi config set appHostname        app.example.com
pulumi config set apiHostname        api.example.com
pulumi config set authHostname       auth.example.com
pulumi config set powersyncHostname  sync.example.com
pulumi config set cloudflareZoneId   <zone-id>
pulumi config set --secret cloudflareApiToken <token>
```

**DNS automation is Cloudflare only.** The deployment creates a proxied CNAME record per hostname and relies on Cloudflare to terminate TLS at the edge; there is no certificate attached to the load balancer itself. Setting a hostname without a Cloudflare zone ID and API token fails the deployment rather than producing an unreachable stack. Using another DNS provider means creating the records yourself against the load balancer address the stack reports, and terminating TLS in front of it.

## Settings

The Target column says which compute target reads the value; anything marked Fargate is ignored on EKS, where the equivalent is a Helm chart value instead.

| Key                            | Target  | Secret | Purpose                                                                          |
| ------------------------------ | ------- | ------ | -------------------------------------------------------------------------------- |
| `aws:region`                   | Both    |        | AWS region.                                                                      |
| `platform`                     | Both    |        | `fargate` (default) or `k8s`.                                                    |
| `version`                      | Both    |        | Image tag to deploy. Required.                                                   |
| `ghcrToken`                    | Both    | yes    | Token for pulling the container images, if you have made them private.           |
| `betterAuthSecret`             | Both    | yes    | Signs user sessions. 32 characters or more.                                      |
| `appUrl`                       | EKS     |        | The address users will reach the deployment on. Defaults to `http://localhost`.  |
| `powersyncJwtSecret`           | Fargate | yes    | Signs sync tokens. 32 characters or more.                                        |
| `postgresPassword`             | Fargate | yes    | Database password.                                                               |
| `powersyncDbPassword`          | Fargate | yes    | Replication password for the sync service.                                       |
| `keycloakAdminPassword`        | Fargate | yes    | Keycloak administrator password.                                                 |
| `oidcClientSecret`             | Fargate | yes    | Secret shared between the API and Keycloak.                                      |
| `anthropicApiKey`              | Fargate | yes    | AI provider key. `fireworksApiKey` and `tinfoilApiKey` are also accepted.        |
| `exaApiKey`                    | Fargate | yes    | Enables web search.                                                              |
| `thunderboltInferenceUrl`      | Fargate |        | Managed inference gateway address, with `thunderboltInferenceApiKey` as its key. |
| `tinfoilEnclaveUrl`            | Fargate |        | Overrides the confidential-tier endpoint. Keep the `/v1` suffix.                 |
| `confidentialApiKeysEnabled`   | Fargate |        | Let a personal access token reach confidential models. Off by default.           |
| `marketingHostname` and others | Fargate |        | Per-service hostnames. See above.                                                |
| `cloudflareZoneId`             | Fargate |        | Required whenever any hostname is set.                                           |
| `cloudflareApiToken`           | Fargate | yes    | Required whenever any hostname is set.                                           |
| `minAppVersion`                | Fargate |        | Refuse requests from clients older than this version. Off when unset.            |
| `cliDeviceRegistrationEnabled` | Fargate |        | Allow command-line clients to register devices. Off by default.                  |

Provider keys are optional. Leave them unset if your users will supply their own keys in the app. Everything else the services read is in the [Configuration reference](./configuration.md).

## Deploying from CI

The repository includes a GitHub Actions workflow that wraps the same deployment. If you fork the repository you can use it as-is: it takes the action (`deploy` or `destroy`), stack name, target, region, version, the hostnames, and the Cloudflare zone as inputs.

Two repository secrets are the minimum. `PULUMI_ACCESS_TOKEN` is a Pulumi Cloud token, which also unlocks the stack secrets, and `AWS_DEPLOY_ROLE_ARN` is an IAM role the workflow assumes through OIDC. A registry token, provider keys, and the Cloudflare token are optional additions. The deploy job runs in a GitHub environment named `preview`, so any secret you scope to an environment has to live in that one.

## What this costs

Costs depend on region and usage. EKS costs more at rest than Fargate because of the control plane and the always-on nodes, so Fargate is the cheaper of the two for a single deployment. These are the parts that bill continuously, so price them in the AWS calculator before you commit:

| Applies to   | Billed continuously                                                                                             |
| ------------ | --------------------------------------------------------------------------------------------------------------- |
| Both targets | NAT gateway (hourly plus data processed), data transfer out                                                     |
| Fargate      | 4 vCPU and 8 GB of tasks running 24/7, the load balancer, EFS storage, CloudWatch logs, Secrets Manager entries |
| EKS          | Cluster control plane (hourly), two `t3.medium` nodes, EBS volumes, the ingress load balancer                   |

## Limits to know about

PostgreSQL runs as one of the containers, on EFS or EBS. There is no managed database option: moving to a service such as Amazon RDS is something you would wire up yourself, and the sync service's own bookkeeping database should not go there (see the caveat on the [self-hosting overview](./README.md)). Nothing snapshots that storage for you either, so set up backups before you store anything you care about.

There is no high availability: one copy of each service, and one NAT gateway in one availability zone. A zone failure takes the deployment down.

Nothing autoscales. Service sizes are fixed, so growing the deployment means changing them.

Keycloak runs in its development mode, which is convenient for a first boot but is not a configuration to serve real users from.

Two more Fargate specifics:

- The database volume is pinned to uid 70, matching the Postgres image's system user. A Postgres major version that changes that uid needs the existing EFS data chowned before the new container starts.
- Logs are kept 7 days, then discarded.

## Switching targets later

Changing `platform` and running `pulumi up` again destroys the old compute and builds the new, reusing the network. **Your data does not come with it.** The EFS filesystem holding the database only exists on the Fargate side, so switching to EKS destroys it and the cluster starts from an empty volume. Dump anything you want to keep first.

## Tear down

```bash
pulumi destroy -y
pulumi stack rm acme-prod -y
```

This deletes the database storage along with everything else.
