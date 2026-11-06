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
  /** Image tag for the shared services (postgres, keycloak). */
  version: string
  /** Image repository prefix; same one used by per-PR stacks for backend/frontend/marketing. */
  imagePrefix: string
  /** GHCR PAT for pulling images. */
  ghcrToken?: pulumi.Output<string>
  /** Cloudflare zone ID for the auth subdomain CNAME. Optional. */
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
  /** Shared AI provider keys — these rarely change and are identical across PR stacks. */
  aiSecrets: {
    anthropicApiKey: pulumi.Output<string>
    fireworksApiKey: pulumi.Output<string>
    thunderboltInferenceApiKey: pulumi.Output<string>
    exaApiKey: pulumi.Output<string>
    tinfoilApiKey: pulumi.Output<string>
  }
  /** Postgres admin password (random per shared-stack; persisted in Pulumi state). */
  postgresPassword: pulumi.Output<string>
  /** Password for `powersync_role`, which the Postgres init script creates. */
  powersyncDbPassword: pulumi.Output<string>
  /** Keycloak admin user password (for the master realm). */
  keycloakAdminPassword: pulumi.Output<string>
  /** PowerSync JWT signing secret (per-PR backends sign with it; per-PR PowerSync verifies). */
  powersyncJwtSecret: pulumi.Output<string>
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
  /** Per-PR backends sign JWTs with this; per-PR PowerSync verifies. Same secret across all PRs. */
  powersyncJwtSecretArn: pulumi.Output<string>
  /** Per-PR backends fetch tokens from `${keycloakIssuerUrl}/.well-known/...`. */
  keycloakIssuerUrl: pulumi.Output<string>
  /**
   * Base URL of the shared Keycloak (no realm suffix). Per-PR stacks point the
   * `@pulumi/keycloak` provider at this URL to provision their own OIDC client.
   */
  keycloakUrl: pulumi.Output<string>
  /** Realm where per-PR OIDC clients are created. */
  keycloakRealm: pulumi.Output<string>
  /** Admin username for the Keycloak admin API (master realm). */
  keycloakAdminUsername: pulumi.Output<string>
  /**
   * Admin password for the Keycloak admin API. Exposed in plaintext through
   * StackReference (encrypted at rest in Pulumi state) so per-PR stacks can
   * construct the keycloak.Provider without a Secrets Manager round-trip at
   * preview time. Same pattern as `postgresPassword`.
   */
  keycloakAdminPassword: pulumi.Output<string>

  // -- Shared AI provider secrets (same values across all per-PR stacks) --
  anthropicApiKeySecretArn: pulumi.Output<string>
  fireworksApiKeySecretArn: pulumi.Output<string>
  thunderboltInferenceApiKeySecretArn: pulumi.Output<string>
  exaApiKeySecretArn: pulumi.Output<string>
  tinfoilApiKeySecretArn: pulumi.Output<string>
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

  const sharedDiscoveryNames = ['postgres', 'keycloak'] as const
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
    // Must stay strictly below the backend keep-alive timeout — see backend/src/index.ts (120s).
    idleTimeout: 60,
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

  // Pre-built host-header rule for the shared Keycloak's subdomain
  // (auth.shared.<base>). Per-PR rules go in the higher priority range starting
  // at 100; reserve 1-99 for shared rules.
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

  new aws.lb.ListenerRule(`${name}-host-auth-rule`, {
    listenerArn: listener.arn,
    priority: 1,
    conditions: [{ hostHeader: { values: [args.authHostname] } }],
    actions: [{ type: 'forward', targetGroupArn: keycloakTg.arn }],
  })

  // Cloudflare CNAME for the shared auth subdomain. Per-PR stacks own their
  // marketing/app/api/powersync CNAMEs.
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

  // AI provider secrets — created in the shared stack so per-PR stacks just reference
  // them. Per-PR exec roles grant GetSecretValue against these ARNs (passed via
  // StackReference outputs).
  const aiSecretSpecs: Array<[keyof SharedStackArgs['aiSecrets'], string]> = [
    ['anthropicApiKey', `${name}-anthropic-api-key`],
    ['fireworksApiKey', `${name}-fireworks-api-key`],
    ['thunderboltInferenceApiKey', `${name}-tb-inference-api-key`],
    ['exaApiKey', `${name}-exa-api-key`],
    ['tinfoilApiKey', `${name}-tinfoil-api-key`],
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

  // Grant the shared exec role read access to all the shared secrets so the postgres
  // and keycloak task definitions below can pull them at start time.
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
        // Every per-PR PowerSync holds a replication slot and a WAL sender (two
        // while it reprocesses a sync-config change); the defaults of 10 each
        // would cap previews well below the ALB's ~25. The WAL cap invalidates a
        // slot left behind by a teardown that skipped drop-preview-db.sh instead
        // of letting it pin WAL forever, though it still occupies a slot.
        command: [
          'postgres',
          '-c',
          'wal_level=logical',
          '-c',
          'max_replication_slots=64',
          '-c',
          'max_wal_senders=64',
          '-c',
          'max_slot_wal_keep_size=2GB',
        ],
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

  // -------- 8. Keycloak ECS service --------
  // The shared Keycloak imports the `thunderbolt` realm at boot. Per-PR stacks
  // each register their own `keycloak.openid.Client` resource in `per-pr-stack.ts`
  // — with `validRedirectUris` and `webOrigins` scoped to that PR's hostnames —
  // because Keycloak's redirect URI matching only honors `*` as a path suffix
  // (no hostname wildcards), so the previous wildcard `api-pr-*.…` redirect URI
  // never matched any real PR host. The `thunderbolt-app` client baked into the
  // realm import still exists but is unused for preview-pr traffic.
  //
  // Keycloak stores its data in the shared Postgres, so those per-PR clients
  // survive a restart; dev mode's default embedded database lives in the
  // container and is wiped with it. With the realm persisted, `--import-realm`
  // skips it on later boots, so edits to keycloak-realm.json no longer reach a
  // running stack. `keycloak-db-init` creates the database, since the Postgres
  // init scripts only run on an empty data directory.
  const kcImage = `${imagePrefix}/thunderbolt-keycloak:${version}`
  const postgresHost = `postgres.${NAMESPACE_DOMAIN}`
  const kcAuthUrl = pulumi.interpolate`https://${args.authHostname}`
  const keycloakRealm = 'thunderbolt'
  const keycloakAdminUsername = 'admin'
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
        name: 'keycloak-db-init',
        image: pgImage,
        essential: false,
        entryPoint: ['sh', '-c'],
        command: [
          `until pg_isready -h ${postgresHost} -U postgres; do sleep 2; done; ` +
            `psql -h ${postgresHost} -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname = 'keycloak'" | grep -q 1 || ` +
            `psql -h ${postgresHost} -U postgres -c 'CREATE DATABASE keycloak'`,
        ],
        secrets: [{ name: 'PGPASSWORD', valueFrom: postgresPasswordSecret.arn }],
        logConfiguration: logConfig('keycloak-db-init'),
        ...(repositoryCredentials && { repositoryCredentials }),
      },
      {
        name: 'keycloak',
        image: kcImage,
        essential: true,
        dependsOn: [{ containerName: 'keycloak-db-init', condition: 'SUCCESS' }],
        command: ['start-dev', '--import-realm'],
        environment: [
          { name: 'KC_BOOTSTRAP_ADMIN_USERNAME', value: keycloakAdminUsername },
          { name: 'KC_BOOTSTRAP_ADMIN_PASSWORD', value: args.keycloakAdminPassword },
          { name: 'KC_HTTP_PORT', value: '8080' },
          { name: 'KC_HOSTNAME', value: kcAuthUrl },
          { name: 'KC_PROXY_HEADERS', value: 'xforwarded' },
          { name: 'KC_DB', value: 'postgres' },
          { name: 'KC_DB_URL', value: `jdbc:postgresql://${postgresHost}:5432/keycloak` },
          { name: 'KC_DB_USERNAME', value: 'postgres' },
        ],
        secrets: [{ name: 'KC_DB_PASSWORD', valueFrom: postgresPasswordSecret.arn }],
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

  // -------- 9. Outputs --------
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
    powersyncJwtSecretArn: powersyncJwtSecretSecret.arn,
    keycloakIssuerUrl: pulumi.interpolate`${kcAuthUrl}/realms/${keycloakRealm}`,
    keycloakUrl: kcAuthUrl,
    keycloakRealm: pulumi.output(keycloakRealm),
    keycloakAdminUsername: pulumi.output(keycloakAdminUsername),
    keycloakAdminPassword: args.keycloakAdminPassword,

    anthropicApiKeySecretArn: aiSecretArns.anthropicApiKey,
    fireworksApiKeySecretArn: aiSecretArns.fireworksApiKey,
    thunderboltInferenceApiKeySecretArn: aiSecretArns.thunderboltInferenceApiKey,
    exaApiKeySecretArn: aiSecretArns.exaApiKey,
    tinfoilApiKeySecretArn: aiSecretArns.tinfoilApiKey,
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
    powersyncJwtSecretArn: get<string>('powersyncJwtSecretArn'),
    keycloakIssuerUrl: get<string>('keycloakIssuerUrl'),
    keycloakUrl: get<string>('keycloakUrl'),
    keycloakRealm: get<string>('keycloakRealm'),
    keycloakAdminUsername: get<string>('keycloakAdminUsername'),
    keycloakAdminPassword: get<string>('keycloakAdminPassword'),
    anthropicApiKeySecretArn: get<string>('anthropicApiKeySecretArn'),
    fireworksApiKeySecretArn: get<string>('fireworksApiKeySecretArn'),
    thunderboltInferenceApiKeySecretArn: get<string>('thunderboltInferenceApiKeySecretArn'),
    exaApiKeySecretArn: get<string>('exaApiKeySecretArn'),
    tinfoilApiKeySecretArn: get<string>('tinfoilApiKeySecretArn'),
  }
}
