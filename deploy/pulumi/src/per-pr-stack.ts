/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as aws from '@pulumi/aws'
import * as cloudflare from '@pulumi/cloudflare'
import * as keycloak from '@pulumi/keycloak'
import * as pulumi from '@pulumi/pulumi'
import * as random from '@pulumi/random'
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
  /** Resolved per-PR subdomains. `auth` comes from shared. */
  hostnames: {
    marketing: pulumi.Input<string>
    app: pulumi.Input<string>
    api: pulumi.Input<string>
    powersync: pulumi.Input<string>
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
  /** Optional Tinfoil enclave URL — same value across all stacks today. */
  tinfoilEnclaveUrl?: pulumi.Input<string>
  /** Minimum compatible app semver enforced before CLI device registration is enabled. */
  minAppVersion: string
  /** Enables server-owned CLI device registration after compatible app clients ship. */
  cliDeviceRegistrationEnabled: boolean
  /** Lets a personal access token reach the confidential (Tinfoil) routes. */
  confidentialApiKeysEnabled: boolean
  /** Operator branding JSON (env: BRANDING_JSON). Empty ships the default look. */
  brandingJson: string
  /** Team named in the debug-transcript share copy. Empty keeps the backend default. */
  debugTranscriptRecipientName: string
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

/** Derive a per-stack DB name from the Pulumi stack name (`preview-pr-846` → `preview_pr_846`). */
const dbNameFromStack = (stackName: string): string => stackName.replace(/[^a-z0-9]/gi, '_').toLowerCase()

/** PowerSync bucket storage DB for a per-stack DB. Must match `backend-entrypoint.sh` and `drop-preview-db.sh`. */
const powersyncStorageDbName = (dbName: string): string => `${dbName}_ps_storage`

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

/** First priority above the three-rule blocks, which top out at 48,099. */
const POWERSYNC_RULE_PRIORITY_BASE = PR_RULE_PRIORITY_BASE + 16000 * 3
const POWERSYNC_RULE_PRIORITY_SPAN = 50000 - POWERSYNC_RULE_PRIORITY_BASE

/**
 * Priority for a stack's PowerSync rule, in a band of its own so adding it moved
 * no existing rule. Keyed on the PR number rather than a hash: open PRs sit in a
 * narrow recent range, so two only collide if their numbers differ by a multiple
 * of the span, where a hash in a band this small would collide routinely.
 */
const powersyncRulePriority = (stackName: string): number => {
  const prNumber = stackName.match(/(\d+)$/)?.[1]
  const offset = prNumber ? Number(prNumber) : stableOffset(stackName, POWERSYNC_RULE_PRIORITY_SPAN)
  return POWERSYNC_RULE_PRIORITY_BASE + (offset % POWERSYNC_RULE_PRIORITY_SPAN)
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
    } satisfies Record<string, pulumi.Input<string>>,
  })

  // -------- 3. Per-PR target groups (4: frontend, backend, marketing, powersync) --------
  // Keycloak's TG lives in the shared stack. PowerSync is per-PR: it replicates
  // this PR's own database, which a shared instance can't (one source DB each).
  const frontendTg = new aws.lb.TargetGroup(`${name}-frontend-tg`, {
    namePrefix: 'tb-fe',
    port: 8080,
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
    port: 8080,
    protocol: 'HTTP',
    targetType: 'ip',
    vpcId: shared.vpcId,
    healthCheck: { path: '/', healthyThreshold: 2, interval: 30 },
    tags: { Name: `${name}-marketing` },
  })

  const powersyncTg = new aws.lb.TargetGroup(`${name}-powersync-tg`, {
    namePrefix: 'tb-ps',
    port: 8080,
    protocol: 'HTTP',
    targetType: 'ip',
    vpcId: shared.vpcId,
    healthCheck: { path: '/probes/liveness', healthyThreshold: 2, interval: 30 },
    tags: { Name: `${name}-powersync` },
  })

  // -------- 4. Per-PR listener rules on shared ALB listener --------
  // ALB rule priorities must be unique per listener; derive a deterministic offset
  // from the stack name so a stack always claims the same trio of priorities.
  // Span keeps comfortable headroom under ALB's max priority (50,000).
  const baseOffset = PR_RULE_PRIORITY_BASE + stableOffset(args.stackName, 16000) * 3

  // ECS rejects a service whose target group isn't attached to the ALB yet, and
  // only these rules attach them, so each service below depends on its rule.
  const marketingRule = new aws.lb.ListenerRule(`${name}-host-marketing-rule`, {
    listenerArn: shared.listenerArn,
    priority: baseOffset,
    conditions: [{ hostHeader: { values: [args.hostnames.marketing] } }],
    actions: [{ type: 'forward', targetGroupArn: marketingTg.arn }],
  })

  const appRule = new aws.lb.ListenerRule(`${name}-host-app-rule`, {
    listenerArn: shared.listenerArn,
    priority: baseOffset + 1,
    conditions: [{ hostHeader: { values: [args.hostnames.app] } }],
    actions: [{ type: 'forward', targetGroupArn: frontendTg.arn }],
  })

  const apiRule = new aws.lb.ListenerRule(`${name}-host-api-rule`, {
    listenerArn: shared.listenerArn,
    priority: baseOffset + 2,
    conditions: [{ hostHeader: { values: [args.hostnames.api] } }],
    actions: [{ type: 'forward', targetGroupArn: backendTg.arn }],
  })

  const powersyncRule = new aws.lb.ListenerRule(`${name}-host-powersync-rule`, {
    listenerArn: shared.listenerArn,
    priority: powersyncRulePriority(args.stackName),
    conditions: [{ hostHeader: { values: [args.hostnames.powersync] } }],
    actions: [{ type: 'forward', targetGroupArn: powersyncTg.arn }],
  })

  // -------- 5. Cloudflare CNAMEs for the per-PR subdomains --------
  // auth.shared.* is owned by the shared stack.
  const cloudflareProvider = new cloudflare.Provider(`${name}-cf`, { apiToken: args.cloudflareApiToken })

  const albFqdn = shared.albDnsName
  const cnameSpecs: Array<{ name: string; hostname: pulumi.Input<string> }> = [
    { name: 'marketing', hostname: args.hostnames.marketing },
    { name: 'app', hostname: args.hostnames.app },
    { name: 'api', hostname: args.hostnames.api },
    { name: 'powersync', hostname: args.hostnames.powersync },
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

  // -------- 6. Per-PR Keycloak OIDC client --------
  // Keycloak only honors `*` as a trailing path wildcard in `validRedirectUris` —
  // hostname wildcards aren't supported — so the shared client can't cover every
  // PR's `api-pr-<n>` host. Each per-PR stack instead provisions its own client
  // in the shared `thunderbolt` realm with exact-match redirect/origin URIs.
  const keycloakProvider = new keycloak.Provider(`${name}-keycloak`, {
    url: shared.keycloakUrl,
    realm: 'master',
    clientId: 'admin-cli',
    username: shared.keycloakAdminUsername,
    password: shared.keycloakAdminPassword,
  })

  const oidcClientSecretValue = new random.RandomPassword(`${name}-oidc-client-secret`, {
    length: 48,
    special: false,
  }).result

  const oidcClientIdValue = `thunderbolt-app-${args.stackName}`
  const apiCallbackUrl = pulumi.interpolate`https://${args.hostnames.api}/v1/api/auth/sso/callback/sso`

  const oidcClient = new keycloak.openid.Client(
    `${name}-oidc-client`,
    {
      realmId: shared.keycloakRealm,
      clientId: oidcClientIdValue,
      name: oidcClientIdValue,
      enabled: true,
      accessType: 'CONFIDENTIAL',
      clientSecret: oidcClientSecretValue,
      standardFlowEnabled: true,
      directAccessGrantsEnabled: false,
      validRedirectUris: [apiCallbackUrl],
      webOrigins: [pulumi.interpolate`https://${args.hostnames.app}`],
    },
    { provider: keycloakProvider },
  )

  // -------- 7. Per-PR secrets --------
  const dbName = dbNameFromStack(args.stackName)

  const oidcClientSecretArn = (() => {
    const s = new aws.secretsmanager.Secret(`${name}-oidc-client-secret`, {
      tags: { Name: `${name}-oidc-client-secret` },
    })
    new aws.secretsmanager.SecretVersion(`${name}-oidc-client-secret-version`, {
      secretId: s.id,
      secretString: oidcClient.clientSecret,
    })
    return s.arn
  })()

  const debugTranscriptKey = new random.RandomPassword(`${name}-debug-transcript-key`, {
    length: 48,
    special: false,
  }).result
  const debugTranscriptKeySecret = new aws.secretsmanager.Secret(`${name}-debug-transcript-key`)
  new aws.secretsmanager.SecretVersion(`${name}-debug-transcript-key-version`, {
    secretId: debugTranscriptKeySecret.id,
    secretString: debugTranscriptKey,
  })

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

  // PowerSync's bucket storage DB, created by the backend entrypoint.
  const powersyncStorageUrlSecret = new aws.secretsmanager.Secret(`${name}-powersync-storage-url`, {
    tags: { Name: `${name}-powersync-storage-url` },
  })
  new aws.secretsmanager.SecretVersion(`${name}-powersync-storage-url-version`, {
    secretId: powersyncStorageUrlSecret.id,
    secretString: pulumi.interpolate`postgresql://postgres:${shared.postgresPassword}@${shared.postgresHost}:${shared.postgresPort}/${powersyncStorageDbName(dbName)}`,
  })

  // PowerSync takes the shared JWT secret base64-encoded, which ECS can't do on
  // the way in, so keep an encoded copy per stack.
  const powersyncJwtKeySecret = new aws.secretsmanager.Secret(`${name}-powersync-jwt-key`, {
    tags: { Name: `${name}-powersync-jwt-key` },
  })
  new aws.secretsmanager.SecretVersion(`${name}-powersync-jwt-key-version`, {
    secretId: powersyncJwtKeySecret.id,
    secretString: aws.secretsmanager
      .getSecretVersionOutput({ secretId: shared.powersyncJwtSecretArn })
      .secretString.apply((s) => Buffer.from(s).toString('base64')),
  })

  // -------- 8. Per-PR exec role policy: read per-PR secrets + shared secrets --------
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
            debugTranscriptKeySecret.arn,
            databaseUrlSecret.arn,
            postgresAdminUrlSecret.arn,
            powersyncStorageUrlSecret.arn,
            powersyncJwtKeySecret.arn,
            oidcClientSecretArn,
            // Shared (consumed by per-PR backend at startup)
            shared.powersyncJwtSecretArn,
            shared.anthropicApiKeySecretArn,
            shared.fireworksApiKeySecretArn,
            shared.thunderboltInferenceApiKeySecretArn,
            shared.exaApiKeySecretArn,
            shared.tinfoilApiKeySecretArn,
          ],
        },
      ],
    }),
  })

  // -------- 9. Per-PR ECS services (backend / frontend / marketing / powersync) --------
  const beImage = `${imagePrefix}/thunderbolt-backend:${version}`
  const feImage = `${imagePrefix}/thunderbolt-frontend:${version}`
  const mkImage = `${imagePrefix}/thunderbolt-marketing:${version}`
  const psImage = `${imagePrefix}/thunderbolt-powersync:${version}`

  const apiUrl = pulumi.interpolate`https://${args.hostnames.api}`
  const appUrl = pulumi.interpolate`https://${args.hostnames.app}`
  const marketingUrl = pulumi.interpolate`https://${args.hostnames.marketing}`
  const powersyncUrl = pulumi.interpolate`https://${args.hostnames.powersync}`

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
          { name: 'OIDC_CLIENT_ID', value: oidcClient.clientId },
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
          { name: 'POWERSYNC_URL', value: powersyncUrl },
          { name: 'POWERSYNC_JWT_KID', value: 'enterprise-powersync' },
          { name: 'RATE_LIMIT_ENABLED', value: 'true' },
          { name: 'MIN_APP_VERSION', value: args.minAppVersion },
          {
            name: 'CLI_DEVICE_REGISTRATION_ENABLED',
            value: args.cliDeviceRegistrationEnabled ? 'true' : 'false',
          },
          {
            name: 'CONFIDENTIAL_API_KEYS_ENABLED',
            value: args.confidentialApiKeysEnabled ? 'true' : 'false',
          },
          // Each preview is both relay and intake for itself, so the full flow runs end to end.
          { name: 'DEBUG_TRANSCRIPT_INTAKE_ENABLED', value: 'true' },
          { name: 'DEBUG_TRANSCRIPT_UPSTREAM_URL', value: apiUrl },
          { name: 'THUNDERBOLT_INFERENCE_URL', value: args.thunderboltInferenceUrl ?? '' },
          { name: 'TINFOIL_ENCLAVE_URL', value: args.tinfoilEnclaveUrl ?? '' },
          // Omitted when empty so the backend applies its own defaults.
          ...(args.brandingJson ? [{ name: 'BRANDING_JSON', value: args.brandingJson }] : []),
          ...(args.debugTranscriptRecipientName
            ? [{ name: 'DEBUG_TRANSCRIPT_RECIPIENT_NAME', value: args.debugTranscriptRecipientName }]
            : []),
          { name: 'TRUSTED_PROXY', value: 'cloudflare' },
        ],
        secrets: [
          { name: 'DATABASE_URL', valueFrom: databaseUrlSecret.arn },
          { name: 'POSTGRES_ADMIN_URL', valueFrom: postgresAdminUrlSecret.arn },
          { name: 'OIDC_CLIENT_SECRET', valueFrom: oidcClientSecretArn },
          { name: 'BETTER_AUTH_SECRET', valueFrom: betterAuthSecretArn },
          { name: 'DEBUG_TRANSCRIPT_UPSTREAM_KEY', valueFrom: debugTranscriptKeySecret.arn },
          { name: 'POWERSYNC_JWT_SECRET', valueFrom: shared.powersyncJwtSecretArn },
          { name: 'ANTHROPIC_API_KEY', valueFrom: shared.anthropicApiKeySecretArn },
          { name: 'FIREWORKS_API_KEY', valueFrom: shared.fireworksApiKeySecretArn },
          { name: 'THUNDERBOLT_INFERENCE_API_KEY', valueFrom: shared.thunderboltInferenceApiKeySecretArn },
          { name: 'EXA_API_KEY', valueFrom: shared.exaApiKeySecretArn },
          { name: 'TINFOIL_API_KEY', valueFrom: shared.tinfoilApiKeySecretArn },
        ],
        portMappings: [{ containerPort: 8000 }],
        logConfiguration: logConfig('backend'),
        ...(repositoryCredentials && { repositoryCredentials }),
      },
    ]),
  })

  new aws.ecs.Service(
    `${name}-be-svc`,
    {
      cluster: shared.clusterArn,
      taskDefinition: beTaskDef.arn,
      desiredCount: 1,
      launchType: 'FARGATE',
      healthCheckGracePeriodSeconds: 120,
      networkConfiguration: { subnets: shared.privateSubnetIds, securityGroups: [shared.servicesSgId] },
      loadBalancers: [{ targetGroupArn: backendTg.arn, containerName: 'backend', containerPort: 8000 }],
    },
    { dependsOn: [apiRule] },
  )

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
        portMappings: [{ containerPort: 8080 }],
        logConfiguration: logConfig('frontend'),
        ...(repositoryCredentials && { repositoryCredentials }),
      },
    ]),
  })

  new aws.ecs.Service(
    `${name}-fe-svc`,
    {
      cluster: shared.clusterArn,
      taskDefinition: feTaskDef.arn,
      desiredCount: 1,
      launchType: 'FARGATE',
      networkConfiguration: { subnets: shared.privateSubnetIds, securityGroups: [shared.servicesSgId] },
      loadBalancers: [{ targetGroupArn: frontendTg.arn, containerName: 'frontend', containerPort: 8080 }],
    },
    { dependsOn: [appRule] },
  )

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
        portMappings: [{ containerPort: 8080 }],
        logConfiguration: logConfig('marketing'),
        ...(repositoryCredentials && { repositoryCredentials }),
      },
    ]),
  })

  new aws.ecs.Service(
    `${name}-mk-svc`,
    {
      cluster: shared.clusterArn,
      taskDefinition: mkTaskDef.arn,
      desiredCount: 1,
      launchType: 'FARGATE',
      networkConfiguration: { subnets: shared.privateSubnetIds, securityGroups: [shared.servicesSgId] },
      loadBalancers: [{ targetGroupArn: marketingTg.arn, containerName: 'marketing', containerPort: 8080 }],
    },
    { dependsOn: [marketingRule] },
  )

  // Built from this PR's commit, so a sync-config change is exercised by its own
  // preview. Replicates the per-PR DB as the postgres superuser, which already
  // holds REPLICATION and reads every table; the backend entrypoint creates the
  // storage DB and the `powersync` publication. Until it has, PowerSync exits
  // and ECS restarts it.
  const psTaskDef = new aws.ecs.TaskDefinition(`${name}-ps-task`, {
    family: `${name}-powersync`,
    requiresCompatibilities: ['FARGATE'],
    networkMode: 'awsvpc',
    cpu: '512',
    memory: '1024',
    executionRoleArn: execRole.arn,
    taskRoleArn: taskRole.arn,
    containerDefinitions: pulumi.jsonStringify([
      {
        name: 'powersync',
        image: psImage,
        essential: true,
        // Must match the backend's POWERSYNC_JWT_KID.
        environment: [{ name: 'PS_JWT_KID', value: 'enterprise-powersync' }],
        secrets: [
          // Same URL as the backend's DATABASE_URL: the database PowerSync replicates.
          { name: 'PS_PG_URI', valueFrom: databaseUrlSecret.arn },
          { name: 'PS_STORAGE_URI', valueFrom: powersyncStorageUrlSecret.arn },
          // base64 of the backend's POWERSYNC_JWT_SECRET.
          { name: 'PS_JWT_KEY_BASE64', valueFrom: powersyncJwtKeySecret.arn },
        ],
        portMappings: [{ containerPort: 8080 }],
        logConfiguration: logConfig('powersync'),
        ...(repositoryCredentials && { repositoryCredentials }),
      },
    ]),
  })

  new aws.ecs.Service(
    `${name}-ps-svc`,
    {
      cluster: shared.clusterArn,
      taskDefinition: psTaskDef.arn,
      desiredCount: 1,
      launchType: 'FARGATE',
      healthCheckGracePeriodSeconds: 120,
      networkConfiguration: { subnets: shared.privateSubnetIds, securityGroups: [shared.servicesSgId] },
      loadBalancers: [{ targetGroupArn: powersyncTg.arn, containerName: 'powersync', containerPort: 8080 }],
    },
    { dependsOn: [powersyncRule] },
  )

  // -------- 10. Outputs --------
  // The auth URL comes from the shared stack so users see one Keycloak per
  // environment regardless of which PR they came in through.
  const authUrl = shared.keycloakIssuerUrl.apply((u) => u.replace(/\/realms\/.*$/, ''))
  return {
    url: marketingUrl,
    urls: {
      marketing: marketingUrl,
      app: appUrl,
      api: apiUrl,
      auth: authUrl,
      powersync: powersyncUrl,
    },
  }
}
