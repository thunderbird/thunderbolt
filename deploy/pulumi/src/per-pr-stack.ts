/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as aws from '@pulumi/aws'
import * as cloudflare from '@pulumi/cloudflare'
import * as pulumi from '@pulumi/pulumi'
import type { SharedStackOutputs } from './shared'

/**
 * Per-PR stack: lightweight, ephemeral. Only owns the things that genuinely change
 * per PR — the application code's ECS services + the per-PR routing/secret plumbing.
 * Depends on a `previews-shared` stack created separately by an earlier workflow run.
 */
export type PerPrStackArgs = {
  stackName: string
  /** Resource name prefix derived from stackName, e.g. `tb-preview-pr-846`. */
  name: string
  /** Image tag (typically the head commit SHA from CI). */
  version: string
  /** Image repository prefix; same one used by shared. */
  imagePrefix: string
  /** GHCR PAT for pulling images. */
  ghcrToken?: pulumi.Output<string>
  /** Resolved per-PR subdomains. `auth` and `powersync` come from shared. */
  hostnames: {
    marketing: pulumi.Input<string>
    app: pulumi.Input<string>
    api: pulumi.Input<string>
  }
  /** Cloudflare zone + token for CNAMEs. */
  cloudflareZoneId: pulumi.Input<string>
  cloudflareApiToken: pulumi.Output<string>
  /** Pulled from the shared stack via StackReference. */
  shared: SharedStackOutputs
  /** PR-specific auth secret (random per stack via random.RandomPassword). */
  betterAuthSecret: pulumi.Output<string>
  /** Optional thunderbolt inference URL — same value across all stacks today. */
  thunderboltInferenceUrl?: pulumi.Input<string>
}

export type PerPrStackOutputs = {
  url: pulumi.Output<string>
  urls: {
    marketing: pulumi.Output<string>
    app: pulumi.Output<string>
    api: pulumi.Output<string>
    auth: pulumi.Output<string>
    powersync: pulumi.Output<string>
  }
}

/** Stable priority offset for per-PR listener rules. Shared stack uses 1-99. */
const PR_RULE_PRIORITY_BASE = 100

/** Derive a per-stack DB name from the Pulumi stack name (`preview-pr-846` → `pr_846`). */
const dbNameFromStack = (stackName: string): string => stackName.replace(/[^a-z0-9]/gi, '_').toLowerCase()

/**
 * Hash the stack name to a small offset for ALB rule priorities. Pulumi-managed
 * rules can't share a priority within the same listener, so each PR needs a
 * deterministic, unique slot. 32-bit FNV-1a fits comfortably under the
 * (50000 - PR_RULE_PRIORITY_BASE) / 3 budget for ~16k concurrent PRs.
 */
const stableOffset = (input: string, span: number): number => {
  let h = 0x811c9dc5 >>> 0
  for (let i = 0; i < input.length; i++) {
    h = (h ^ input.charCodeAt(i)) >>> 0
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h % span
}

export const createPerPrStack = (args: PerPrStackArgs): PerPrStackOutputs => {
  const { name, version, imagePrefix, ghcrToken, shared } = args
  const region = aws.getRegionOutput().region

  // -------- 1. Per-PR IAM (separate from shared so we don't accumulate inline policies on the shared role) --------
  const execRole = new aws.iam.Role(`${name}-exec-role`, {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: 'ecs-tasks.amazonaws.com' }),
    managedPolicyArns: [aws.iam.ManagedPolicy.AmazonECSTaskExecutionRolePolicy],
    tags: { Name: `${name}-exec-role` },
  })

  const taskRole = new aws.iam.Role(`${name}-task-role`, {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: 'ecs-tasks.amazonaws.com' }),
    tags: { Name: `${name}-task-role` },
  })

  // -------- 2. GHCR pull credentials (per-PR; rotates with stack) --------
  let repositoryCredentials: { credentialsParameter: pulumi.Output<string> } | undefined
  if (ghcrToken) {
    const ghcrSecret = new aws.secretsmanager.Secret(`${name}-ghcr-creds`, {
      tags: { Name: `${name}-ghcr-creds` },
    })
    new aws.secretsmanager.SecretVersion(`${name}-ghcr-creds-version`, {
      secretId: ghcrSecret.id,
      secretString: pulumi.jsonStringify({ username: 'oauth2', password: ghcrToken }),
    })
    new aws.iam.RolePolicy(`${name}-exec-ghcr-policy`, {
      role: execRole.name,
      policy: pulumi.jsonStringify({
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Action: ['secretsmanager:GetSecretValue'], Resource: ghcrSecret.arn }],
      }),
    })
    repositoryCredentials = { credentialsParameter: ghcrSecret.arn }
  }

  const logConfig = (streamPrefix: string) => ({
    logDriver: 'awslogs',
    options: {
      'awslogs-group': shared.logGroupName,
      'awslogs-region': region,
      'awslogs-stream-prefix': streamPrefix,
    } as Record<string, pulumi.Input<string>>,
  })

  // -------- 3. Per-PR target groups (3: frontend, backend, marketing) --------
  // Keycloak + PowerSync TGs live in the shared stack. Per-PR backend connects
  // to those services in-cluster (postgres) or via shared subdomains (auth, powersync).
  const frontendTg = new aws.lb.TargetGroup(`${name}-frontend-tg`, {
    namePrefix: 'tb-fe',
    port: 80,
    protocol: 'HTTP',
    targetType: 'ip',
    vpcId: shared.vpcId,
    healthCheck: { path: '/', healthyThreshold: 2, interval: 30 },
    tags: { Name: `${name}-frontend` },
  })

  const backendTg = new aws.lb.TargetGroup(`${name}-backend-tg`, {
    namePrefix: 'tb-be',
    port: 8000,
    protocol: 'HTTP',
    targetType: 'ip',
    vpcId: shared.vpcId,
    healthCheck: { path: '/v1/health', healthyThreshold: 2, interval: 30 },
    tags: { Name: `${name}-backend` },
  })

  const marketingTg = new aws.lb.TargetGroup(`${name}-marketing-tg`, {
    namePrefix: 'tb-mk',
    port: 80,
    protocol: 'HTTP',
    targetType: 'ip',
    vpcId: shared.vpcId,
    healthCheck: { path: '/', healthyThreshold: 2, interval: 30 },
    tags: { Name: `${name}-marketing` },
  })

  // -------- 4. Per-PR listener rules on shared ALB listener --------
  // ALB rule priorities must be unique per listener; derive a deterministic offset
  // from the stack name so a stack always claims the same trio of priorities.
  // Span keeps comfortable headroom under ALB's max priority (50,000).
  const baseOffset = PR_RULE_PRIORITY_BASE + stableOffset(args.stackName, 16000) * 3

  new aws.lb.ListenerRule(`${name}-host-marketing-rule`, {
    listenerArn: shared.listenerArn,
    priority: baseOffset,
    conditions: [{ hostHeader: { values: [args.hostnames.marketing] } }],
    actions: [{ type: 'forward', targetGroupArn: marketingTg.arn }],
  })

  new aws.lb.ListenerRule(`${name}-host-app-rule`, {
    listenerArn: shared.listenerArn,
    priority: baseOffset + 1,
    conditions: [{ hostHeader: { values: [args.hostnames.app] } }],
    actions: [{ type: 'forward', targetGroupArn: frontendTg.arn }],
  })

  new aws.lb.ListenerRule(`${name}-host-api-rule`, {
    listenerArn: shared.listenerArn,
    priority: baseOffset + 2,
    conditions: [{ hostHeader: { values: [args.hostnames.api] } }],
    actions: [{ type: 'forward', targetGroupArn: backendTg.arn }],
  })

  // -------- 5. Cloudflare CNAMEs for the per-PR subdomains --------
  // auth.shared.* and powersync.shared.* are owned by the shared stack.
  const cloudflareProvider = new cloudflare.Provider(`${name}-cf`, { apiToken: args.cloudflareApiToken })

  const albFqdn = shared.albDnsName
  const cnameSpecs: Array<{ name: string; hostname: pulumi.Input<string> }> = [
    { name: 'marketing', hostname: args.hostnames.marketing },
    { name: 'app', hostname: args.hostnames.app },
    { name: 'api', hostname: args.hostnames.api },
  ]
  for (const { name: subdomain, hostname } of cnameSpecs) {
    new cloudflare.Record(
      `${name}-cname-${subdomain}`,
      {
        zoneId: args.cloudflareZoneId,
        name: hostname as pulumi.Input<string>,
        type: 'CNAME',
        content: albFqdn,
        proxied: true,
        ttl: 1, // CF requires ttl=1 (auto) when proxied
      },
      { provider: cloudflareProvider },
    )
  }

  // -------- 6. Per-PR secrets --------
  const dbName = dbNameFromStack(args.stackName)

  const betterAuthSecretArn = (() => {
    const s = new aws.secretsmanager.Secret(`${name}-better-auth-secret`, {
      tags: { Name: `${name}-better-auth-secret` },
    })
    new aws.secretsmanager.SecretVersion(`${name}-better-auth-secret-version`, {
      secretId: s.id,
      secretString: args.betterAuthSecret,
    })
    return s.arn
  })()

  // DATABASE_URL points at the per-PR DB on shared Postgres. The backend's entrypoint
  // (deploy/docker/backend-entrypoint.sh) creates the DB on first run if it doesn't
  // exist using POSTGRES_ADMIN_URL.
  const databaseUrlSecret = new aws.secretsmanager.Secret(`${name}-database-url`, {
    tags: { Name: `${name}-database-url` },
  })
  new aws.secretsmanager.SecretVersion(`${name}-database-url-version`, {
    secretId: databaseUrlSecret.id,
    secretString: pulumi.interpolate`postgresql://postgres:${shared.postgresPassword}@${shared.postgresHost}:${shared.postgresPort}/${dbName}`,
  })

  const postgresAdminUrlSecret = new aws.secretsmanager.Secret(`${name}-postgres-admin-url`, {
    tags: { Name: `${name}-postgres-admin-url` },
  })
  new aws.secretsmanager.SecretVersion(`${name}-postgres-admin-url-version`, {
    secretId: postgresAdminUrlSecret.id,
    secretString: pulumi.interpolate`postgresql://postgres:${shared.postgresPassword}@${shared.postgresHost}:${shared.postgresPort}/postgres`,
  })

  // -------- 7. Per-PR exec role policy: read per-PR secrets + shared secrets --------
  new aws.iam.RolePolicy(`${name}-exec-secrets-policy`, {
    role: execRole.name,
    policy: pulumi.jsonStringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: ['secretsmanager:GetSecretValue'],
          Resource: [
            // Per-PR
            betterAuthSecretArn,
            databaseUrlSecret.arn,
            postgresAdminUrlSecret.arn,
            // Shared (consumed by per-PR backend at startup)
            shared.oidcClientSecretArn,
            shared.powersyncJwtSecretArn,
            shared.anthropicApiKeySecretArn,
            shared.fireworksApiKeySecretArn,
            shared.mistralApiKeySecretArn,
            shared.thunderboltInferenceApiKeySecretArn,
            shared.exaApiKeySecretArn,
          ],
        },
      ],
    }),
  })

  // -------- 8. Per-PR ECS services (backend / frontend / marketing) --------
  const beImage = `${imagePrefix}/thunderbolt-backend:${version}`
  const feImage = `${imagePrefix}/thunderbolt-frontend:${version}`
  const mkImage = `${imagePrefix}/thunderbolt-marketing:${version}`

  const apiUrl = pulumi.interpolate`https://${args.hostnames.api}`
  const appUrl = pulumi.interpolate`https://${args.hostnames.app}`
  const marketingUrl = pulumi.interpolate`https://${args.hostnames.marketing}`

  const beTaskDef = new aws.ecs.TaskDefinition(`${name}-be-task`, {
    family: `${name}-backend`,
    requiresCompatibilities: ['FARGATE'],
    networkMode: 'awsvpc',
    cpu: '1024',
    memory: '2048',
    executionRoleArn: execRole.arn,
    taskRoleArn: taskRole.arn,
    containerDefinitions: pulumi.jsonStringify([
      {
        name: 'backend',
        image: beImage,
        essential: true,
        environment: [
          { name: 'NODE_ENV', value: 'production' },
          { name: 'PORT', value: '8000' },
          { name: 'AUTH_MODE', value: 'oidc' },
          { name: 'WAITLIST_ENABLED', value: 'false' },
          { name: 'DATABASE_DRIVER', value: 'postgres' },
          { name: 'OIDC_ISSUER', value: shared.keycloakIssuerUrl },
          { name: 'OIDC_CLIENT_ID', value: shared.oidcClientId },
          { name: 'BETTER_AUTH_URL', value: apiUrl },
          { name: 'APP_URL', value: appUrl },
          // TRUSTED_ORIGINS includes the shared auth subdomain (Better Auth's SSO
          // plugin validates the OIDC discovery URL's origin is trusted before
          // fetching the .well-known doc).
          {
            name: 'TRUSTED_ORIGINS',
            value: pulumi.interpolate`${appUrl},${marketingUrl},https://${args.hostnames.api},${shared.keycloakIssuerUrl.apply((u) => u.replace(/\/realms\/.*$/, ''))}`,
          },
          { name: 'CORS_ORIGINS', value: pulumi.interpolate`${appUrl},${marketingUrl}` },
          { name: 'CORS_ORIGIN_REGEX', value: '' },
          { name: 'POWERSYNC_URL', value: shared.powersyncPublicUrl },
          { name: 'POWERSYNC_JWT_KID', value: 'enterprise-powersync' },
          { name: 'RATE_LIMIT_ENABLED', value: 'true' },
          { name: 'THUNDERBOLT_INFERENCE_URL', value: args.thunderboltInferenceUrl ?? '' },
          { name: 'TRUSTED_PROXY', value: 'cloudflare' },
        ],
        secrets: [
          { name: 'DATABASE_URL', valueFrom: databaseUrlSecret.arn },
          { name: 'POSTGRES_ADMIN_URL', valueFrom: postgresAdminUrlSecret.arn },
          { name: 'OIDC_CLIENT_SECRET', valueFrom: shared.oidcClientSecretArn },
          { name: 'BETTER_AUTH_SECRET', valueFrom: betterAuthSecretArn },
          { name: 'POWERSYNC_JWT_SECRET', valueFrom: shared.powersyncJwtSecretArn },
          { name: 'ANTHROPIC_API_KEY', valueFrom: shared.anthropicApiKeySecretArn },
          { name: 'FIREWORKS_API_KEY', valueFrom: shared.fireworksApiKeySecretArn },
          { name: 'MISTRAL_API_KEY', valueFrom: shared.mistralApiKeySecretArn },
          { name: 'THUNDERBOLT_INFERENCE_API_KEY', valueFrom: shared.thunderboltInferenceApiKeySecretArn },
          { name: 'EXA_API_KEY', valueFrom: shared.exaApiKeySecretArn },
        ],
        portMappings: [{ containerPort: 8000 }],
        logConfiguration: logConfig('backend'),
        ...(repositoryCredentials && { repositoryCredentials }),
      },
    ]),
  })

  new aws.ecs.Service(`${name}-be-svc`, {
    cluster: shared.clusterArn,
    taskDefinition: beTaskDef.arn,
    desiredCount: 1,
    launchType: 'FARGATE',
    healthCheckGracePeriodSeconds: 120,
    networkConfiguration: { subnets: shared.privateSubnetIds, securityGroups: [shared.servicesSgId] },
    loadBalancers: [{ targetGroupArn: backendTg.arn, containerName: 'backend', containerPort: 8000 }],
  })

  const feTaskDef = new aws.ecs.TaskDefinition(`${name}-fe-task`, {
    family: `${name}-frontend`,
    requiresCompatibilities: ['FARGATE'],
    networkMode: 'awsvpc',
    cpu: '256',
    memory: '512',
    executionRoleArn: execRole.arn,
    taskRoleArn: taskRole.arn,
    containerDefinitions: pulumi.jsonStringify([
      {
        name: 'frontend',
        image: feImage,
        essential: true,
        portMappings: [{ containerPort: 80 }],
        logConfiguration: logConfig('frontend'),
        ...(repositoryCredentials && { repositoryCredentials }),
      },
    ]),
  })

  new aws.ecs.Service(`${name}-fe-svc`, {
    cluster: shared.clusterArn,
    taskDefinition: feTaskDef.arn,
    desiredCount: 1,
    launchType: 'FARGATE',
    networkConfiguration: { subnets: shared.privateSubnetIds, securityGroups: [shared.servicesSgId] },
    loadBalancers: [{ targetGroupArn: frontendTg.arn, containerName: 'frontend', containerPort: 80 }],
  })

  const mkTaskDef = new aws.ecs.TaskDefinition(`${name}-mk-task`, {
    family: `${name}-marketing`,
    requiresCompatibilities: ['FARGATE'],
    networkMode: 'awsvpc',
    cpu: '256',
    memory: '512',
    executionRoleArn: execRole.arn,
    taskRoleArn: taskRole.arn,
    containerDefinitions: pulumi.jsonStringify([
      {
        name: 'marketing',
        image: mkImage,
        essential: true,
        portMappings: [{ containerPort: 80 }],
        logConfiguration: logConfig('marketing'),
        ...(repositoryCredentials && { repositoryCredentials }),
      },
    ]),
  })

  new aws.ecs.Service(`${name}-mk-svc`, {
    cluster: shared.clusterArn,
    taskDefinition: mkTaskDef.arn,
    desiredCount: 1,
    launchType: 'FARGATE',
    networkConfiguration: { subnets: shared.privateSubnetIds, securityGroups: [shared.servicesSgId] },
    loadBalancers: [{ targetGroupArn: marketingTg.arn, containerName: 'marketing', containerPort: 80 }],
  })

  // -------- 9. Outputs --------
  // Auth + powersync URLs come from the shared stack so users see consistent
  // hostnames per environment regardless of which PR they came in through.
  const authUrl = shared.keycloakIssuerUrl.apply((u) => u.replace(/\/realms\/.*$/, ''))
  return {
    url: marketingUrl,
    urls: {
      marketing: marketingUrl,
      app: appUrl,
      api: apiUrl,
      auth: authUrl,
      powersync: shared.powersyncPublicUrl,
    },
  }
}
