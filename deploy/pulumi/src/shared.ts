/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as aws from '@pulumi/aws'
import * as cloudflare from '@pulumi/cloudflare'
import * as pulumi from '@pulumi/pulumi'
import { createVpc } from './vpc'
import { createStorage } from './storage'
import { createCluster } from './cluster'

/**
 * Shared "previews-shared" stack: long-lived, expensive infra that all `preview-pr-*`
 * stacks depend on via StackReference. Creating this once instead of per PR is the
 * leverage point for the cost / quota work — see `deploy/pulumi/SHARED.md`.
 */
export type SharedStackArgs = {
  /** Stack-derived name prefix (e.g. "tb-previews-shared"). */
  name: string
  /** Image tag for the shared services (postgres, keycloak, powersync). */
  version: string
  /** Image repository prefix; same one used by per-PR stacks for backend/frontend/marketing. */
  imagePrefix: string
  /** GHCR PAT for pulling images. */
  ghcrToken?: pulumi.Output<string>
  /** Cloudflare zone ID for the auth + powersync subdomain CNAMEs. Optional. */
  cloudflareZoneId?: pulumi.Input<string>
  /** Cloudflare API token (paired with cloudflareZoneId). Optional. */
  cloudflareApiToken?: pulumi.Output<string>
  /**
   * Public hostname for the shared Keycloak (e.g. "auth.shared.preview.thunderbolt.io").
   * Per-PR backends use `${authHostname}/realms/thunderbolt` as the OIDC issuer.
   * Required if `previews-shared` will serve PR previews — without it the per-PR
   * frontend can't redirect users into Keycloak's UI.
   */
  authHostname: pulumi.Input<string>
  /**
   * Public hostname for shared PowerSync. Per-PR backends issue JWTs the user's
   * browser presents to this endpoint over WSS for sync.
   */
  powersyncHostname: pulumi.Input<string>
  /** Shared AI provider keys — these rarely change and are identical across PR stacks. */
  aiSecrets: {
    anthropicApiKey: pulumi.Output<string>
    fireworksApiKey: pulumi.Output<string>
    mistralApiKey: pulumi.Output<string>
    thunderboltInferenceApiKey: pulumi.Output<string>
    exaApiKey: pulumi.Output<string>
  }
  /** Postgres admin password (random per shared-stack; persisted in Pulumi state). */
  postgresPassword: pulumi.Output<string>
  /** Replication role password used by PowerSync to connect to Postgres. */
  powersyncDbPassword: pulumi.Output<string>
  /** Keycloak admin user password (for the master realm). */
  keycloakAdminPassword: pulumi.Output<string>
  /** PowerSync JWT signing secret (per-PR backends sign with this; PowerSync verifies). */
  powersyncJwtSecret: pulumi.Output<string>
  /**
   * Wildcard hostname for per-PR API subdomains, e.g. `api-pr-*.preview.thunderbolt.io`.
   * The shared Keycloak realm registers a single OIDC client whose `redirectUris`
   * field uses this wildcard, so all per-PR backends share one client_id/secret
   * but Keycloak validates the redirect target matches the wildcard pattern.
   */
  prApiHostPattern: pulumi.Input<string>
  /** Wildcard hostname for per-PR app subdomains, e.g. `app-pr-*.preview.thunderbolt.io`. */
  prAppHostPattern: pulumi.Input<string>
  /** Shared OIDC client secret (random per shared-stack; used by all per-PR backends). */
  oidcClientSecret: pulumi.Output<string>
}

/**
 * Outputs surfaced for `preview-pr-*` stacks via StackReference. Keep stable —
 * any rename here breaks every per-PR stack that consumes it.
 */
export type SharedStackOutputs = {
  // -- Networking --
  vpcId: pulumi.Output<string>
  // Arrays are exported as `Output<string[]>` (single output of an array), not
  // `Output<string>[]` (array of outputs), because StackReference flattens them.
  publicSubnetIds: pulumi.Output<string[]>
  privateSubnetIds: pulumi.Output<string[]>
  servicesSgId: pulumi.Output<string>
  albSgId: pulumi.Output<string>

  // -- ECS --
  clusterArn: pulumi.Output<string>
  clusterName: pulumi.Output<string>
  logGroupName: pulumi.Output<string>
  execRoleArn: pulumi.Output<string>
  taskRoleArn: pulumi.Output<string>

  // -- Edge --
  albArn: pulumi.Output<string>
  albDnsName: pulumi.Output<string>
  albZoneId: pulumi.Output<string>
  listenerArn: pulumi.Output<string>

  // -- Storage --
  efsId: pulumi.Output<string>

  // -- Service Discovery --
  serviceDiscoveryNamespaceId: pulumi.Output<string>
  serviceDiscoveryNamespaceName: pulumi.Output<string>

  // -- Backing services (in-cluster DNS + secret ARNs) --
  postgresHost: pulumi.Output<string>
  postgresPort: pulumi.Output<number>
  postgresAdminPasswordSecretArn: pulumi.Output<string>
  /**
   * Plaintext postgres admin password, sourced from the shared stack's
   * `random.RandomPassword`. Exported so per-PR stacks can `pulumi.interpolate`
   * it into DATABASE_URL strings without round-tripping through Secrets Manager
   * at preview time. Pulumi state is encrypted at rest so this is safe.
   */
  postgresPassword: pulumi.Output<string>
  /** In-cluster PowerSync hostname (`powersync.thunderbolt.local`). */
  powersyncHost: pulumi.Output<string>
  /** Public PowerSync URL the user's browser connects to. */
  powersyncPublicUrl: pulumi.Output<string>
  /** Per-PR backends sign JWTs with this; PowerSync verifies. Same secret across all PRs. */
  powersyncJwtSecretArn: pulumi.Output<string>
  /** Per-PR backends fetch tokens from `${keycloakIssuerUrl}/.well-known/...`. */
  keycloakIssuerUrl: pulumi.Output<string>
  /** OIDC client id all per-PR backends use against the shared Keycloak realm. */
  oidcClientId: pulumi.Output<string>
  /** Secrets Manager ARN holding the OIDC client secret for the above client. */
  oidcClientSecretArn: pulumi.Output<string>

  // -- Shared AI provider secrets (same values across all per-PR stacks) --
  anthropicApiKeySecretArn: pulumi.Output<string>
  fireworksApiKeySecretArn: pulumi.Output<string>
  mistralApiKeySecretArn: pulumi.Output<string>
  thunderboltInferenceApiKeySecretArn: pulumi.Output<string>
  exaApiKeySecretArn: pulumi.Output<string>
}

const NAMESPACE_DOMAIN = 'thunderbolt.local'

export const createSharedStack = (args: SharedStackArgs): SharedStackOutputs => {
  const { name, version, imagePrefix, ghcrToken } = args

  // -------- 1. Networking + storage + cluster (existing helpers) --------
  const { vpc, publicSubnets, privateSubnets, albSg, servicesSg } = createVpc(name)
  const { efs, pgAccessPoint } = createStorage(
    name,
    vpc.id,
    privateSubnets.map((s) => s.id),
    servicesSg.id,
  )
  const { cluster, logGroup } = createCluster(name)

  // -------- 2. Service discovery namespace + entries for shared services --------
  // Per-PR backend/frontend/marketing register their own services in this namespace
  // (the namespace is shared, the services are per-PR).
  const namespace = new aws.servicediscovery.PrivateDnsNamespace(`${name}-ns`, {
    name: NAMESPACE_DOMAIN,
    vpc: vpc.id,
    tags: { Name: `${name}-ns` },
  })

  const sharedDiscoveryNames = ['postgres', 'powersync', 'keycloak'] as const
  const discovery = Object.fromEntries(
    sharedDiscoveryNames.map((svc) => [
      svc,
      new aws.servicediscovery.Service(`${name}-${svc}-discovery`, {
        name: svc,
        namespaceId: namespace.id,
        dnsConfig: {
          namespaceId: namespace.id,
          dnsRecords: [{ ttl: 10, type: 'A' }],
          routingPolicy: 'MULTIVALUE',
        },
        healthCheckCustomConfig: { failureThreshold: 1 },
        tags: { Name: `${name}-${svc}` },
      }),
    ]),
  ) as Record<(typeof sharedDiscoveryNames)[number], aws.servicediscovery.Service>

  // -------- 3. ALB + HTTPS listener (no target groups — those are per-PR) --------
  // The listener default action returns a 404. Per-PR stacks add host-header rules
  // at higher priority, so any PR-specific traffic gets routed correctly; bare IP
  // hits or hostnames not yet wired return 404 instead of accidentally serving
  // another PR's frontend.
  const alb = new aws.lb.LoadBalancer(`${name}-alb`, {
    internal: false,
    loadBalancerType: 'application',
    securityGroups: [albSg.id],
    subnets: publicSubnets.map((s) => s.id),
    tags: { Name: `${name}-alb` },
  })

  const listener = new aws.lb.Listener(`${name}-listener`, {
    loadBalancerArn: alb.arn,
    port: 80,
    protocol: 'HTTP',
    defaultActions: [
      {
        type: 'fixed-response',
        fixedResponse: {
          statusCode: '404',
          contentType: 'text/plain',
          messageBody: 'Not found — the requested host is not configured on this preview ALB.',
        },
      },
    ],
  })

  // Pre-built host-header rules for the shared services' own subdomains
  // (auth.shared.<base>, powersync.shared.<base>). Per-PR rules go in the higher
  // priority range starting at 100; reserve 1-99 for shared rules.
  const keycloakTg = new aws.lb.TargetGroup(`${name}-keycloak-tg`, {
    namePrefix: 'tb-kc',
    port: 8080,
    protocol: 'HTTP',
    targetType: 'ip',
    vpcId: vpc.id,
    healthCheck: {
      path: '/realms/master/.well-known/openid-configuration',
      healthyThreshold: 2,
      interval: 30,
      matcher: '200',
    },
    tags: { Name: `${name}-keycloak` },
  })

  const powersyncTg = new aws.lb.TargetGroup(`${name}-powersync-tg`, {
    namePrefix: 'tb-ps',
    port: 8080,
    protocol: 'HTTP',
    targetType: 'ip',
    vpcId: vpc.id,
    healthCheck: { path: '/probes/liveness', healthyThreshold: 2, interval: 30 },
    tags: { Name: `${name}-powersync` },
  })

  new aws.lb.ListenerRule(`${name}-host-auth-rule`, {
    listenerArn: listener.arn,
    priority: 1,
    conditions: [{ hostHeader: { values: [args.authHostname] } }],
    actions: [{ type: 'forward', targetGroupArn: keycloakTg.arn }],
  })

  new aws.lb.ListenerRule(`${name}-host-powersync-rule`, {
    listenerArn: listener.arn,
    priority: 2,
    conditions: [{ hostHeader: { values: [args.powersyncHostname] } }],
    actions: [{ type: 'forward', targetGroupArn: powersyncTg.arn }],
  })

  // Cloudflare CNAMEs for the shared subdomains (auth + powersync).
  // Per-PR stacks own their own marketing/app/api CNAMEs separately.
  if (args.cloudflareZoneId && args.cloudflareApiToken) {
    const cfProvider = new cloudflare.Provider(`${name}-cf`, {
      apiToken: args.cloudflareApiToken,
    })
    new cloudflare.Record(
      `${name}-cname-auth`,
      {
        zoneId: args.cloudflareZoneId,
        name: args.authHostname,
        type: 'CNAME',
        content: alb.dnsName,
        proxied: true,
        ttl: 1,
      },
      { provider: cfProvider },
    )
    new cloudflare.Record(
      `${name}-cname-powersync`,
      {
        zoneId: args.cloudflareZoneId,
        name: args.powersyncHostname,
        type: 'CNAME',
        content: alb.dnsName,
        proxied: true,
        ttl: 1,
      },
      { provider: cfProvider },
    )
  }

  // -------- 4. IAM roles (shared exec + task roles) --------
  const execRole = new aws.iam.Role(`${name}-exec-role`, {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: 'ecs-tasks.amazonaws.com' }),
    managedPolicyArns: [aws.iam.ManagedPolicy.AmazonECSTaskExecutionRolePolicy],
    tags: { Name: `${name}-exec-role` },
  })

  const taskRole = new aws.iam.Role(`${name}-task-role`, {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: 'ecs-tasks.amazonaws.com' }),
    tags: { Name: `${name}-task-role` },
  })

  // EFS access for postgres
  new aws.iam.RolePolicy(`${name}-task-efs-policy`, {
    role: taskRole.name,
    policy: pulumi.jsonStringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite', 'elasticfilesystem:ClientRootAccess'],
          Resource: '*',
        },
      ],
    }),
  })

  // -------- 5. GHCR pull credentials (Secrets Manager) --------
  let repositoryCredentials: { credentialsParameter: pulumi.Output<string> } | undefined
  if (ghcrToken) {
    const ghcrSecret = new aws.secretsmanager.Secret(`${name}-ghcr-creds`, {
      tags: { Name: `${name}-ghcr-creds` },
    })
    new aws.secretsmanager.SecretVersion(`${name}-ghcr-creds-version`, {
      secretId: ghcrSecret.id,
      secretString: pulumi.jsonStringify({ username: 'oauth2', password: ghcrToken }),
    })
    new aws.iam.RolePolicy(`${name}-exec-secrets-policy`, {
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
      'awslogs-group': logGroup.name,
      'awslogs-region': aws.getRegionOutput().region,
      'awslogs-stream-prefix': streamPrefix,
    } as Record<string, pulumi.Input<string>>,
  })

  // -------- 6. Shared secrets (Secrets Manager) --------
  const postgresPasswordSecret = new aws.secretsmanager.Secret(`${name}-postgres-password`, {
    tags: { Name: `${name}-postgres-password` },
  })
  new aws.secretsmanager.SecretVersion(`${name}-postgres-password-secret-version`, {
    secretId: postgresPasswordSecret.id,
    secretString: args.postgresPassword,
  })

  const powersyncDbPasswordSecret = new aws.secretsmanager.Secret(`${name}-powersync-db-password`, {
    tags: { Name: `${name}-powersync-db-password` },
  })
  new aws.secretsmanager.SecretVersion(`${name}-powersync-db-password-secret-version`, {
    secretId: powersyncDbPasswordSecret.id,
    secretString: args.powersyncDbPassword,
  })

  const powersyncJwtSecretSecret = new aws.secretsmanager.Secret(`${name}-powersync-jwt-secret`, {
    tags: { Name: `${name}-powersync-jwt-secret` },
  })
  new aws.secretsmanager.SecretVersion(`${name}-powersync-jwt-secret-version`, {
    secretId: powersyncJwtSecretSecret.id,
    secretString: args.powersyncJwtSecret,
  })

  const oidcClientSecretSecret = new aws.secretsmanager.Secret(`${name}-oidc-client-secret`, {
    tags: { Name: `${name}-oidc-client-secret` },
  })
  new aws.secretsmanager.SecretVersion(`${name}-oidc-client-secret-version`, {
    secretId: oidcClientSecretSecret.id,
    secretString: args.oidcClientSecret,
  })

  // AI provider secrets — created in the shared stack so per-PR stacks just reference
  // them. Per-PR exec roles grant GetSecretValue against these ARNs (passed via
  // StackReference outputs).
  const aiSecretSpecs: Array<[keyof SharedStackArgs['aiSecrets'], string]> = [
    ['anthropicApiKey', `${name}-anthropic-api-key`],
    ['fireworksApiKey', `${name}-fireworks-api-key`],
    ['mistralApiKey', `${name}-mistral-api-key`],
    ['thunderboltInferenceApiKey', `${name}-tb-inference-api-key`],
    ['exaApiKey', `${name}-exa-api-key`],
  ]
  const aiSecretArns: Record<keyof SharedStackArgs['aiSecrets'], pulumi.Output<string>> = {} as ReturnType<typeof Object>
  for (const [key, secretName] of aiSecretSpecs) {
    const secret = new aws.secretsmanager.Secret(secretName, { tags: { Name: secretName } })
    new aws.secretsmanager.SecretVersion(`${secretName}-version`, {
      secretId: secret.id,
      secretString: args.aiSecrets[key],
    })
    aiSecretArns[key] = secret.arn
  }

  // Grant the shared exec role read access to all the shared secrets so the postgres,
  // powersync, and keycloak task definitions below can pull them at start time.
  // Per-PR stacks attach their OWN role policies for their per-PR secrets.
  new aws.iam.RolePolicy(`${name}-exec-shared-secrets-policy`, {
    role: execRole.name,
    policy: pulumi.jsonStringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: ['secretsmanager:GetSecretValue'],
          Resource: [
            postgresPasswordSecret.arn,
            powersyncDbPasswordSecret.arn,
            powersyncJwtSecretSecret.arn,
          ],
        },
      ],
    }),
  })

  // -------- 7. Postgres ECS service --------
  const pgImage = `${imagePrefix}/thunderbolt-postgres:${version}`
  const pgTaskDef = new aws.ecs.TaskDefinition(`${name}-pg-task`, {
    family: `${name}-postgres`,
    requiresCompatibilities: ['FARGATE'],
    networkMode: 'awsvpc',
    cpu: '1024',
    memory: '2048',
    executionRoleArn: execRole.arn,
    taskRoleArn: taskRole.arn,
    volumes: [
      {
        name: 'pg-data',
        efsVolumeConfiguration: {
          fileSystemId: efs.id,
          transitEncryption: 'ENABLED',
          authorizationConfig: { accessPointId: pgAccessPoint.id, iam: 'ENABLED' },
        },
      },
    ],
    containerDefinitions: pulumi.jsonStringify([
      {
        name: 'postgres',
        image: pgImage,
        essential: true,
        command: ['postgres', '-c', 'wal_level=logical'],
        stopTimeout: 120,
        environment: [
          { name: 'POSTGRES_USER', value: 'postgres' },
          { name: 'POSTGRES_DB', value: 'postgres' },
          { name: 'PGDATA', value: '/var/lib/postgresql/data/pgdata' },
        ],
        secrets: [
          { name: 'POSTGRES_PASSWORD', valueFrom: postgresPasswordSecret.arn },
          { name: 'POWERSYNC_DB_PASSWORD', valueFrom: powersyncDbPasswordSecret.arn },
        ],
        portMappings: [{ containerPort: 5432 }],
        mountPoints: [{ sourceVolume: 'pg-data', containerPath: '/var/lib/postgresql/data' }],
        logConfiguration: logConfig('postgres'),
        ...(repositoryCredentials && { repositoryCredentials }),
      },
    ]),
  })

  new aws.ecs.Service(`${name}-pg-svc`, {
    cluster: cluster.arn,
    taskDefinition: pgTaskDef.arn,
    desiredCount: 1,
    launchType: 'FARGATE',
    deploymentMinimumHealthyPercent: 0,
    deploymentMaximumPercent: 100,
    networkConfiguration: { subnets: privateSubnets.map((s) => s.id), securityGroups: [servicesSg.id] },
    serviceRegistries: { registryArn: discovery.postgres.arn },
  })

  // -------- 8. PowerSync ECS service --------
  const psImage = `${imagePrefix}/thunderbolt-powersync:${version}`
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
        environment: [
          {
            name: 'PS_PG_URI',
            value: pulumi.interpolate`postgresql://powersync_role:${args.powersyncDbPassword}@postgres.${NAMESPACE_DOMAIN}:5432/postgres`,
          },
          {
            name: 'PS_STORAGE_URI',
            value: pulumi.interpolate`postgresql://postgres:${args.postgresPassword}@postgres.${NAMESPACE_DOMAIN}:5432/powersync_storage`,
          },
          // Base64 of POWERSYNC_JWT_SECRET. Read by powersync-config.yaml's
          // `client_auth.jwks.keys[].k: !env POWERSYNC_JWT_KEY_BASE64` to verify
          // the JWT signatures the backend issues. Must match the secret the backend
          // signs with — both come from the same `args.powersyncJwtSecret`.
          {
            name: 'POWERSYNC_JWT_KEY_BASE64',
            value: args.powersyncJwtSecret.apply((s) => Buffer.from(s).toString('base64')),
          },
        ],
        portMappings: [{ containerPort: 8080 }],
        logConfiguration: logConfig('powersync'),
        ...(repositoryCredentials && { repositoryCredentials }),
      },
    ]),
  })

  new aws.ecs.Service(`${name}-ps-svc`, {
    cluster: cluster.arn,
    taskDefinition: psTaskDef.arn,
    desiredCount: 1,
    launchType: 'FARGATE',
    networkConfiguration: { subnets: privateSubnets.map((s) => s.id), securityGroups: [servicesSg.id] },
    serviceRegistries: { registryArn: discovery.powersync.arn },
    loadBalancers: [{ targetGroupArn: powersyncTg.arn, containerName: 'powersync', containerPort: 8080 }],
  }, { dependsOn: [listener] })

  // -------- 9. Keycloak ECS service --------
  // The shared Keycloak imports the `thunderbolt` realm at boot. Per-PR backends
  // each register a Keycloak OIDC client (via the @pulumi/keycloak provider in
  // per-pr-stack.ts) with its own redirect URI matching the PR's `api-pr-<n>` host.
  const kcImage = `${imagePrefix}/thunderbolt-keycloak:${version}`
  const kcAuthUrl = pulumi.interpolate`https://${args.authHostname}`
  const kcTaskDef = new aws.ecs.TaskDefinition(`${name}-kc-task`, {
    family: `${name}-keycloak`,
    requiresCompatibilities: ['FARGATE'],
    networkMode: 'awsvpc',
    cpu: '1024',
    memory: '2048',
    executionRoleArn: execRole.arn,
    taskRoleArn: taskRole.arn,
    containerDefinitions: pulumi.jsonStringify([
      {
        name: 'keycloak',
        image: kcImage,
        essential: true,
        command: ['start-dev', '--import-realm'],
        environment: [
          { name: 'KC_BOOTSTRAP_ADMIN_USERNAME', value: 'admin' },
          { name: 'KC_BOOTSTRAP_ADMIN_PASSWORD', value: args.keycloakAdminPassword },
          { name: 'KC_HTTP_PORT', value: '8080' },
          { name: 'KC_HOSTNAME', value: kcAuthUrl },
          { name: 'KC_PROXY_HEADERS', value: 'xforwarded' },
          // The shared Keycloak realm registers ONE `thunderbolt-app` client. Its
          // redirectUris / webOrigins use wildcards (`api-pr-*.…`) so every per-PR
          // backend can use the same client_id + client_secret without per-PR realm
          // mutation. Tradeoff vs. dynamic per-PR clients: less isolation between PRs,
          // but no Keycloak admin API plumbing needed in per-pr-stack.ts.
          { name: 'OIDC_REDIRECT_URI', value: pulumi.interpolate`https://${args.prApiHostPattern}/v1/api/auth/sso/callback/sso` },
          { name: 'OIDC_WEB_ORIGIN', value: pulumi.interpolate`https://${args.prAppHostPattern}` },
          // The realm import substitutes ${OIDC_CLIENT_SECRET} into the
          // `thunderbolt-app` client's `secret` field. Without this, Keycloak would
          // fall back to the realm file's built-in default and per-PR backends —
          // which receive the random secret via `oidcClientSecretArn` — would fail
          // OIDC token exchange.
          { name: 'OIDC_CLIENT_SECRET', value: args.oidcClientSecret },
        ],
        portMappings: [{ containerPort: 8080 }],
        logConfiguration: logConfig('keycloak'),
        ...(repositoryCredentials && { repositoryCredentials }),
      },
    ]),
  })

  new aws.ecs.Service(`${name}-kc-svc`, {
    cluster: cluster.arn,
    taskDefinition: kcTaskDef.arn,
    desiredCount: 1,
    launchType: 'FARGATE',
    healthCheckGracePeriodSeconds: 300,
    networkConfiguration: { subnets: privateSubnets.map((s) => s.id), securityGroups: [servicesSg.id] },
    serviceRegistries: { registryArn: discovery.keycloak.arn },
    loadBalancers: [{ targetGroupArn: keycloakTg.arn, containerName: 'keycloak', containerPort: 8080 }],
  }, { dependsOn: [listener] })

  // -------- 10. Outputs --------
  return {
    vpcId: vpc.id,
    publicSubnetIds: pulumi.output(publicSubnets.map((s) => s.id)),
    privateSubnetIds: pulumi.output(privateSubnets.map((s) => s.id)),
    servicesSgId: servicesSg.id,
    albSgId: albSg.id,

    clusterArn: cluster.arn,
    clusterName: cluster.name,
    logGroupName: logGroup.name,
    execRoleArn: execRole.arn,
    taskRoleArn: taskRole.arn,

    albArn: alb.arn,
    albDnsName: alb.dnsName,
    albZoneId: alb.zoneId,
    listenerArn: listener.arn,

    efsId: efs.id,

    serviceDiscoveryNamespaceId: namespace.id,
    serviceDiscoveryNamespaceName: namespace.name,

    postgresHost: pulumi.output(`postgres.${NAMESPACE_DOMAIN}`),
    postgresPort: pulumi.output(5432),
    postgresAdminPasswordSecretArn: postgresPasswordSecret.arn,
    postgresPassword: args.postgresPassword,
    powersyncHost: pulumi.output(`powersync.${NAMESPACE_DOMAIN}`),
    powersyncPublicUrl: pulumi.interpolate`https://${args.powersyncHostname}`,
    powersyncJwtSecretArn: powersyncJwtSecretSecret.arn,
    keycloakIssuerUrl: pulumi.interpolate`${kcAuthUrl}/realms/thunderbolt`,
    oidcClientId: pulumi.output('thunderbolt-app'),
    oidcClientSecretArn: oidcClientSecretSecret.arn,

    anthropicApiKeySecretArn: aiSecretArns.anthropicApiKey,
    fireworksApiKeySecretArn: aiSecretArns.fireworksApiKey,
    mistralApiKeySecretArn: aiSecretArns.mistralApiKey,
    thunderboltInferenceApiKeySecretArn: aiSecretArns.thunderboltInferenceApiKey,
    exaApiKeySecretArn: aiSecretArns.exaApiKey,
  }
}

/**
 * Read a `previews-shared` stack's outputs through a StackReference into the
 * `SharedStackOutputs` shape per-pr-stack.ts expects. Centralizes the casts
 * so the consumer never has to know the keys exist.
 */
export const loadSharedStackOutputs = (ref: pulumi.StackReference): SharedStackOutputs => {
  const get = <T>(key: keyof SharedStackOutputs): pulumi.Output<T> =>
    ref.requireOutput(key as string) as pulumi.Output<T>
  return {
    vpcId: get<string>('vpcId'),
    publicSubnetIds: get<string[]>('publicSubnetIds'),
    privateSubnetIds: get<string[]>('privateSubnetIds'),
    servicesSgId: get<string>('servicesSgId'),
    albSgId: get<string>('albSgId'),
    clusterArn: get<string>('clusterArn'),
    clusterName: get<string>('clusterName'),
    logGroupName: get<string>('logGroupName'),
    execRoleArn: get<string>('execRoleArn'),
    taskRoleArn: get<string>('taskRoleArn'),
    albArn: get<string>('albArn'),
    albDnsName: get<string>('albDnsName'),
    albZoneId: get<string>('albZoneId'),
    listenerArn: get<string>('listenerArn'),
    efsId: get<string>('efsId'),
    serviceDiscoveryNamespaceId: get<string>('serviceDiscoveryNamespaceId'),
    serviceDiscoveryNamespaceName: get<string>('serviceDiscoveryNamespaceName'),
    postgresHost: get<string>('postgresHost'),
    postgresPort: get<number>('postgresPort'),
    postgresAdminPasswordSecretArn: get<string>('postgresAdminPasswordSecretArn'),
    postgresPassword: get<string>('postgresPassword'),
    powersyncHost: get<string>('powersyncHost'),
    powersyncPublicUrl: get<string>('powersyncPublicUrl'),
    powersyncJwtSecretArn: get<string>('powersyncJwtSecretArn'),
    keycloakIssuerUrl: get<string>('keycloakIssuerUrl'),
    oidcClientId: get<string>('oidcClientId'),
    oidcClientSecretArn: get<string>('oidcClientSecretArn'),
    anthropicApiKeySecretArn: get<string>('anthropicApiKeySecretArn'),
    fireworksApiKeySecretArn: get<string>('fireworksApiKeySecretArn'),
    mistralApiKeySecretArn: get<string>('mistralApiKeySecretArn'),
    thunderboltInferenceApiKeySecretArn: get<string>('thunderboltInferenceApiKeySecretArn'),
    exaApiKeySecretArn: get<string>('exaApiKeySecretArn'),
  }
}
