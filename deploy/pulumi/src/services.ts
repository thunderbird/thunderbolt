/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as aws from '@pulumi/aws'
import * as pulumi from '@pulumi/pulumi'

type Images = {
  frontend: string
  backend: string
  postgres: string
  keycloak: string
  powersync: string
  marketing: string
}

type Secrets = {
  postgresPassword: pulumi.Output<string>
  keycloakAdminPassword: pulumi.Output<string>
  oidcClientSecret: pulumi.Output<string>
  powersyncJwtSecret: pulumi.Output<string>
  betterAuthSecret: pulumi.Output<string>
  powersyncDbPassword: pulumi.Output<string>
  anthropicApiKey: pulumi.Output<string>
  fireworksApiKey: pulumi.Output<string>
  mistralApiKey: pulumi.Output<string>
  thunderboltInferenceApiKey: pulumi.Output<string>
  exaApiKey: pulumi.Output<string>
}

type ServiceArgs = {
  name: string
  cluster: aws.ecs.Cluster
  logGroup: aws.cloudwatch.LogGroup
  privateSubnetIds: pulumi.Input<string>[]
  servicesSgId: pulumi.Input<string>
  efsId: pulumi.Input<string>
  pgAccessPointId: pulumi.Input<string>
  images: Images
  secrets: Secrets
  ghcrToken?: pulumi.Output<string>
  /**
   * Per-service public URLs (including scheme). Each service's URL is used for
   * the URL-related env vars it needs (OIDC redirects, CORS origins, WebSocket
   * endpoints, etc.).
   *
   * For enterprise stacks without subdomain routing, all five URLs will be the
   * raw ALB hostname (`http://tb-....elb.amazonaws.com`) and routing will fall
   * back to path-based rules on the ALB.
   *
   * For preview stacks, each is a distinct Cloudflare subdomain
   * (e.g. `https://app-pr-123.preview.thunderbolt.io`).
   */
  publicUrls: {
    marketing: pulumi.Input<string>
    app: pulumi.Input<string>
    api: pulumi.Input<string>
    auth: pulumi.Input<string>
    powersync: pulumi.Input<string>
  }
  /** URL for the Thunderbolt inference gateway (env: THUNDERBOLT_INFERENCE_URL). Optional. */
  thunderboltInferenceUrl?: pulumi.Input<string>
  /**
   * When true, backend runs behind a proxy whose X-Forwarded-* headers we trust
   * for client IP extraction (Cloudflare edge for preview stacks).
   */
  behindCloudflareProxy?: boolean
  albListener: aws.lb.Listener
  targetGroups: {
    frontend: aws.lb.TargetGroup
    backend: aws.lb.TargetGroup
    keycloak: aws.lb.TargetGroup
    powersync: aws.lb.TargetGroup
    marketing: aws.lb.TargetGroup
  }
  discoveryServices: Record<string, aws.servicediscovery.Service>
}

export const createServices = (args: ServiceArgs) => {
  const { name, cluster, logGroup, privateSubnetIds, servicesSgId, efsId, pgAccessPointId } = args
  const region = aws.getRegionOutput().region

  // --- IAM roles ---
  const execRoleInstance = new aws.iam.Role(`${name}-exec-role`, {
    assumeRolePolicy: JSON.stringify({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Principal: { Service: 'ecs-tasks.amazonaws.com' }, Action: 'sts:AssumeRole' }],
    }),
    managedPolicyArns: ['arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy'],
    tags: { Name: `${name}-exec-role` },
  })

  const taskRoleInstance = new aws.iam.Role(`${name}-task-role`, {
    assumeRolePolicy: JSON.stringify({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Principal: { Service: 'ecs-tasks.amazonaws.com' }, Action: 'sts:AssumeRole' }],
    }),
    tags: { Name: `${name}-task-role` },
  })

  // EFS IAM authorization for volume mounts (defense-in-depth alongside security groups)
  new aws.iam.RolePolicy(`${name}-task-efs-policy`, {
    role: taskRoleInstance.name,
    policy: pulumi.jsonStringify({
      Version: '2012-10-17',
      Statement: [{
        Effect: 'Allow',
        Action: ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite'],
        Resource: [pulumi.interpolate`arn:aws:elasticfilesystem:${region}:*:file-system/${efsId}`],
      }],
    }),
  })

  // --- GHCR registry auth (for pulling private images) ---
  const repositoryCredentials = (() => {
    if (!args.ghcrToken) return undefined

    const ghcrSecret = new aws.secretsmanager.Secret(`${name}-ghcr-creds`, {
      tags: { Name: `${name}-ghcr-creds` },
    })

    new aws.secretsmanager.SecretVersion(`${name}-ghcr-creds-version`, {
      secretId: ghcrSecret.id,
      secretString: pulumi.interpolate`{"username":"oauth2","password":"${args.ghcrToken}"}`,
    })

    new aws.iam.RolePolicy(`${name}-exec-secrets-policy`, {
      role: execRoleInstance.name,
      policy: pulumi.jsonStringify({
        Version: '2012-10-17',
        Statement: [{
          Effect: 'Allow',
          Action: ['secretsmanager:GetSecretValue'],
          Resource: [ghcrSecret.arn],
        }],
      }),
    })

    return { credentialsParameter: ghcrSecret.arn }
  })()

  const execRoleArn = execRoleInstance.arn
  const taskRoleArn = taskRoleInstance.arn

  const logConfig = (container: string) => ({
    logDriver: 'awslogs' as const,
    options: {
      'awslogs-group': logGroup.name,
      'awslogs-region': region,
      'awslogs-stream-prefix': container,
    },
  })

  // --- Postgres ---
  const pgTaskDef = new aws.ecs.TaskDefinition(`${name}-pg-task`, {
    family: `${name}-postgres`,
    requiresCompatibilities: ['FARGATE'],
    networkMode: 'awsvpc',
    cpu: '1024',
    memory: '2048',
    executionRoleArn: execRoleArn,
    taskRoleArn,
    volumes: [
      {
        name: 'pg-data',
        efsVolumeConfiguration: {
          fileSystemId: efsId,
          transitEncryption: 'ENABLED',
          authorizationConfig: { accessPointId: pgAccessPointId, iam: 'ENABLED' },
        },
      },
    ],
    containerDefinitions: pulumi.jsonStringify([
      {
        name: 'postgres',
        image: args.images.postgres,
        essential: true,
        // `-m fast` flushes WAL + checkpoints on shutdown. stopTimeout of 120s
        // (Fargate max) gives postgres time to complete the checkpoint before
        // SIGKILL arrives. Without this, rolling updates can corrupt WAL.
        command: ['postgres', '-c', 'wal_level=logical'],
        stopTimeout: 120,
        environment: [
          { name: 'POSTGRES_USER', value: 'postgres' },
          { name: 'POSTGRES_DB', value: 'postgres' },
          { name: 'POSTGRES_PASSWORD', value: args.secrets.postgresPassword },
          { name: 'PGDATA', value: '/var/lib/postgresql/data/pgdata' },
        ],
        portMappings: [{ containerPort: 5432 }],
        mountPoints: [{ sourceVolume: 'pg-data', containerPath: '/var/lib/postgresql/data' }],
        logConfiguration: logConfig('postgres'),
        ...(repositoryCredentials && { repositoryCredentials }),
      },
    ]),
  })

  const pgService = new aws.ecs.Service(`${name}-pg-svc`, {
    cluster: cluster.arn,
    taskDefinition: pgTaskDef.arn,
    desiredCount: 1,
    launchType: 'FARGATE',
    // Stop the old task completely before starting a new one. Postgres with a
    // single EFS-backed volume can't have two replicas running simultaneously —
    // overlap causes WAL corruption. Trade small downtime (~30s) for data safety.
    deploymentMinimumHealthyPercent: 0,
    deploymentMaximumPercent: 100,
    networkConfiguration: {
      subnets: privateSubnetIds,
      securityGroups: [servicesSgId],
    },
    serviceRegistries: { registryArn: args.discoveryServices['postgres'].arn },
  })

  // --- PowerSync ---
  const psTaskDef = new aws.ecs.TaskDefinition(`${name}-ps-task`, {
    family: `${name}-powersync`,
    requiresCompatibilities: ['FARGATE'],
    networkMode: 'awsvpc',
    cpu: '512',
    memory: '1024',
    executionRoleArn: execRoleArn,
    taskRoleArn,
    containerDefinitions: pulumi.jsonStringify([
      {
        name: 'powersync',
        image: args.images.powersync,
        essential: true,
        environment: [
          { name: 'PS_PG_URI', value: pulumi.interpolate`postgresql://powersync_role:${args.secrets.powersyncDbPassword}@postgres.thunderbolt.local:5432/postgres` },
          { name: 'PS_STORAGE_URI', value: pulumi.interpolate`postgresql://postgres:${args.secrets.postgresPassword}@postgres.thunderbolt.local:5432/powersync_storage` },
        ],
        portMappings: [{ containerPort: 8080 }],
        logConfiguration: logConfig('powersync'),
        ...(repositoryCredentials && { repositoryCredentials }),
      },
    ]),
  })

  const psService = new aws.ecs.Service(`${name}-ps-svc`, {
    cluster: cluster.arn,
    taskDefinition: psTaskDef.arn,
    desiredCount: 1,
    launchType: 'FARGATE',
    healthCheckGracePeriodSeconds: 120,
    networkConfiguration: {
      subnets: privateSubnetIds,
      securityGroups: [servicesSgId],
    },
    serviceRegistries: { registryArn: args.discoveryServices['powersync'].arn },
    loadBalancers: [
      { targetGroupArn: args.targetGroups.powersync.arn, containerName: 'powersync', containerPort: 8080 },
    ],
  }, { dependsOn: [args.albListener, pgService] })

  // --- Keycloak ---
  const kcTaskDef = new aws.ecs.TaskDefinition(`${name}-kc-task`, {
    family: `${name}-keycloak`,
    requiresCompatibilities: ['FARGATE'],
    networkMode: 'awsvpc',
    cpu: '1024',
    memory: '2048',
    executionRoleArn: execRoleArn,
    taskRoleArn,
    containerDefinitions: pulumi.jsonStringify([
      {
        name: 'keycloak',
        image: args.images.keycloak,
        essential: true,
        command: ['start-dev', '--import-realm'],
        environment: [
          { name: 'KC_BOOTSTRAP_ADMIN_USERNAME', value: 'admin' },
          { name: 'KC_BOOTSTRAP_ADMIN_PASSWORD', value: args.secrets.keycloakAdminPassword },
          { name: 'KC_HTTP_PORT', value: '8080' },
          // Keycloak 26 hostname v2: full URL in KC_HOSTNAME, scheme (https) inferred from it.
          // Both frontchannel and backchannel URLs are built from this — issuer,
          // token_endpoint, etc. all get the https scheme.
          { name: 'KC_HOSTNAME', value: args.publicUrls.auth },
          // Trust X-Forwarded-Proto from Cloudflare/ALB for client-facing protocol detection.
          { name: 'KC_PROXY_HEADERS', value: 'xforwarded' },
          // Realm import substitutes ${OIDC_REDIRECT_URI} / ${OIDC_WEB_ORIGIN} so the
          // baked-in realm JSON works for both local dev (defaults) and Fargate (real URLs).
          // Redirect URI = backend OAuth callback (BETTER_AUTH_URL = publicUrls.api).
          { name: 'OIDC_REDIRECT_URI', value: pulumi.interpolate`${args.publicUrls.api}/v1/api/auth/oauth2/callback/oidc` },
          { name: 'OIDC_WEB_ORIGIN', value: args.publicUrls.app },
        ],
        portMappings: [{ containerPort: 8080 }],
        logConfiguration: logConfig('keycloak'),
        ...(repositoryCredentials && { repositoryCredentials }),
      },
    ]),
  })

  const kcService = new aws.ecs.Service(`${name}-kc-svc`, {
    cluster: cluster.arn,
    taskDefinition: kcTaskDef.arn,
    desiredCount: 1,
    launchType: 'FARGATE',
    // Keycloak dev-mode cold start is ~50s. Give ECS 5 min before it starts
    // killing tasks that haven't passed ALB health checks yet.
    healthCheckGracePeriodSeconds: 300,
    networkConfiguration: {
      subnets: privateSubnetIds,
      securityGroups: [servicesSgId],
    },
    serviceRegistries: { registryArn: args.discoveryServices['keycloak'].arn },
    loadBalancers: [
      { targetGroupArn: args.targetGroups.keycloak.arn, containerName: 'keycloak', containerPort: 8080 },
    ],
  }, { dependsOn: [args.albListener] })

  // --- Backend secrets (stored in Secrets Manager, not as cleartext env vars) ---
  const backendSecrets = {
    oidcClientSecret: new aws.secretsmanager.Secret(`${name}-oidc-secret`, {
      tags: { Name: `${name}-oidc-secret` },
    }),
    betterAuthSecret: new aws.secretsmanager.Secret(`${name}-better-auth-secret`, {
      tags: { Name: `${name}-better-auth-secret` },
    }),
    powersyncJwtSecret: new aws.secretsmanager.Secret(`${name}-powersync-jwt-secret`, {
      tags: { Name: `${name}-powersync-jwt-secret` },
    }),
    databaseUrl: new aws.secretsmanager.Secret(`${name}-database-url`, {
      tags: { Name: `${name}-database-url` },
    }),
    // AI provider keys. Created unconditionally; empty values are accepted by
    // backend zod schema (`.default('')`). Enterprise deploys pass empty strings;
    // preview deploys get real values via `pulumi config set --secret` in CI.
    anthropicApiKey: new aws.secretsmanager.Secret(`${name}-anthropic-api-key`, {
      tags: { Name: `${name}-anthropic-api-key` },
    }),
    fireworksApiKey: new aws.secretsmanager.Secret(`${name}-fireworks-api-key`, {
      tags: { Name: `${name}-fireworks-api-key` },
    }),
    mistralApiKey: new aws.secretsmanager.Secret(`${name}-mistral-api-key`, {
      tags: { Name: `${name}-mistral-api-key` },
    }),
    thunderboltInferenceApiKey: new aws.secretsmanager.Secret(`${name}-tb-inference-api-key`, {
      tags: { Name: `${name}-tb-inference-api-key` },
    }),
    exaApiKey: new aws.secretsmanager.Secret(`${name}-exa-api-key`, {
      tags: { Name: `${name}-exa-api-key` },
    }),
  }

  new aws.secretsmanager.SecretVersion(`${name}-oidc-secret-version`, {
    secretId: backendSecrets.oidcClientSecret.id,
    secretString: args.secrets.oidcClientSecret,
  })
  new aws.secretsmanager.SecretVersion(`${name}-better-auth-secret-version`, {
    secretId: backendSecrets.betterAuthSecret.id,
    secretString: args.secrets.betterAuthSecret,
  })
  new aws.secretsmanager.SecretVersion(`${name}-powersync-jwt-secret-version`, {
    secretId: backendSecrets.powersyncJwtSecret.id,
    secretString: args.secrets.powersyncJwtSecret,
  })
  new aws.secretsmanager.SecretVersion(`${name}-database-url-version`, {
    secretId: backendSecrets.databaseUrl.id,
    secretString: pulumi.interpolate`postgresql://postgres:${args.secrets.postgresPassword}@postgres.thunderbolt.local:5432/postgres`,
  })
  new aws.secretsmanager.SecretVersion(`${name}-anthropic-api-key-version`, {
    secretId: backendSecrets.anthropicApiKey.id,
    secretString: args.secrets.anthropicApiKey,
  })
  new aws.secretsmanager.SecretVersion(`${name}-fireworks-api-key-version`, {
    secretId: backendSecrets.fireworksApiKey.id,
    secretString: args.secrets.fireworksApiKey,
  })
  new aws.secretsmanager.SecretVersion(`${name}-mistral-api-key-version`, {
    secretId: backendSecrets.mistralApiKey.id,
    secretString: args.secrets.mistralApiKey,
  })
  new aws.secretsmanager.SecretVersion(`${name}-tb-inference-api-key-version`, {
    secretId: backendSecrets.thunderboltInferenceApiKey.id,
    secretString: args.secrets.thunderboltInferenceApiKey,
  })
  new aws.secretsmanager.SecretVersion(`${name}-exa-api-key-version`, {
    secretId: backendSecrets.exaApiKey.id,
    secretString: args.secrets.exaApiKey,
  })

  new aws.iam.RolePolicy(`${name}-exec-backend-secrets-policy`, {
    role: execRoleInstance.name,
    policy: pulumi.jsonStringify({
      Version: '2012-10-17',
      Statement: [{
        Effect: 'Allow',
        Action: ['secretsmanager:GetSecretValue'],
        Resource: [
          backendSecrets.oidcClientSecret.arn,
          backendSecrets.betterAuthSecret.arn,
          backendSecrets.powersyncJwtSecret.arn,
          backendSecrets.databaseUrl.arn,
          backendSecrets.anthropicApiKey.arn,
          backendSecrets.fireworksApiKey.arn,
          backendSecrets.mistralApiKey.arn,
          backendSecrets.thunderboltInferenceApiKey.arn,
          backendSecrets.exaApiKey.arn,
        ],
      }],
    }),
  })

  // --- Backend ---
  const beTaskDef = new aws.ecs.TaskDefinition(`${name}-be-task`, {
    family: `${name}-backend`,
    requiresCompatibilities: ['FARGATE'],
    networkMode: 'awsvpc',
    cpu: '1024',
    memory: '2048',
    executionRoleArn: execRoleArn,
    taskRoleArn,
    containerDefinitions: pulumi.jsonStringify([
      {
        name: 'backend',
        image: args.images.backend,
        essential: true,
        environment: [
          { name: 'NODE_ENV', value: 'production' },
          { name: 'PORT', value: '8000' },
          { name: 'AUTH_MODE', value: 'oidc' },
          { name: 'WAITLIST_ENABLED', value: 'false' },
          { name: 'DATABASE_DRIVER', value: 'postgres' },
          { name: 'OIDC_ISSUER', value: pulumi.interpolate`${args.publicUrls.auth}/realms/thunderbolt` },
          { name: 'OIDC_CLIENT_ID', value: 'thunderbolt-app' },
          // BETTER_AUTH_URL = where backend is served. Keycloak redirects OAuth
          // callbacks here; setting it to the app URL would route through the
          // frontend's nginx proxy (which requires different DNS config).
          { name: 'BETTER_AUTH_URL', value: args.publicUrls.api },
          { name: 'APP_URL', value: args.publicUrls.app },
          { name: 'TRUSTED_ORIGINS', value: pulumi.interpolate`${args.publicUrls.app},${args.publicUrls.marketing}` },
          { name: 'CORS_ORIGINS', value: pulumi.interpolate`${args.publicUrls.app},${args.publicUrls.marketing}` },
          { name: 'CORS_ORIGIN_REGEX', value: '' },
          { name: 'POWERSYNC_URL', value: args.publicUrls.powersync },
          { name: 'POWERSYNC_JWT_KID', value: 'enterprise-powersync' },
          { name: 'RATE_LIMIT_ENABLED', value: 'true' },
          { name: 'THUNDERBOLT_INFERENCE_URL', value: args.thunderboltInferenceUrl ?? '' },
          // Cloudflare terminates TLS for preview stacks — trust its CF-Connecting-IP
          // header for rate limiting. Enterprise stacks leave this unset (direct socket IP).
          { name: 'TRUSTED_PROXY', value: args.behindCloudflareProxy ? 'cloudflare' : '' },
        ],
        secrets: [
          { name: 'DATABASE_URL', valueFrom: backendSecrets.databaseUrl.arn },
          { name: 'OIDC_CLIENT_SECRET', valueFrom: backendSecrets.oidcClientSecret.arn },
          { name: 'BETTER_AUTH_SECRET', valueFrom: backendSecrets.betterAuthSecret.arn },
          { name: 'POWERSYNC_JWT_SECRET', valueFrom: backendSecrets.powersyncJwtSecret.arn },
          { name: 'ANTHROPIC_API_KEY', valueFrom: backendSecrets.anthropicApiKey.arn },
          { name: 'FIREWORKS_API_KEY', valueFrom: backendSecrets.fireworksApiKey.arn },
          { name: 'MISTRAL_API_KEY', valueFrom: backendSecrets.mistralApiKey.arn },
          { name: 'THUNDERBOLT_INFERENCE_API_KEY', valueFrom: backendSecrets.thunderboltInferenceApiKey.arn },
          { name: 'EXA_API_KEY', valueFrom: backendSecrets.exaApiKey.arn },
        ],
        portMappings: [{ containerPort: 8000 }],
        logConfiguration: logConfig('backend'),
        ...(repositoryCredentials && { repositoryCredentials }),
      },
    ]),
  })

  const beService = new aws.ecs.Service(`${name}-be-svc`, {
    cluster: cluster.arn,
    taskDefinition: beTaskDef.arn,
    desiredCount: 1,
    launchType: 'FARGATE',
    // Backend runs Drizzle migrations on startup before the server listens.
    healthCheckGracePeriodSeconds: 120,
    networkConfiguration: {
      subnets: privateSubnetIds,
      securityGroups: [servicesSgId],
    },
    serviceRegistries: { registryArn: args.discoveryServices['backend'].arn },
    loadBalancers: [
      { targetGroupArn: args.targetGroups.backend.arn, containerName: 'backend', containerPort: 8000 },
    ],
  }, { dependsOn: [args.albListener] })

  // --- Frontend ---
  const feTaskDef = new aws.ecs.TaskDefinition(`${name}-fe-task`, {
    family: `${name}-frontend`,
    requiresCompatibilities: ['FARGATE'],
    networkMode: 'awsvpc',
    cpu: '256',
    memory: '512',
    executionRoleArn: execRoleArn,
    taskRoleArn,
    containerDefinitions: pulumi.jsonStringify([
      {
        name: 'frontend',
        image: args.images.frontend,
        essential: true,
        portMappings: [{ containerPort: 80 }],
        logConfiguration: logConfig('frontend'),
        ...(repositoryCredentials && { repositoryCredentials }),
      },
    ]),
  })

  const feService = new aws.ecs.Service(`${name}-fe-svc`, {
    cluster: cluster.arn,
    taskDefinition: feTaskDef.arn,
    desiredCount: 1,
    launchType: 'FARGATE',
    networkConfiguration: {
      subnets: privateSubnetIds,
      securityGroups: [servicesSgId],
    },
    serviceRegistries: { registryArn: args.discoveryServices['frontend'].arn },
    loadBalancers: [
      { targetGroupArn: args.targetGroups.frontend.arn, containerName: 'frontend', containerPort: 80 },
    ],
  }, { dependsOn: [args.albListener] })

  // --- Marketing (Astro static site: landing page, blog, docs) ---
  const mkTaskDef = new aws.ecs.TaskDefinition(`${name}-mk-task`, {
    family: `${name}-marketing`,
    requiresCompatibilities: ['FARGATE'],
    networkMode: 'awsvpc',
    cpu: '256',
    memory: '512',
    executionRoleArn: execRoleArn,
    taskRoleArn,
    containerDefinitions: pulumi.jsonStringify([
      {
        name: 'marketing',
        image: args.images.marketing,
        essential: true,
        portMappings: [{ containerPort: 80 }],
        logConfiguration: logConfig('marketing'),
        ...(repositoryCredentials && { repositoryCredentials }),
      },
    ]),
  })

  const mkService = new aws.ecs.Service(`${name}-mk-svc`, {
    cluster: cluster.arn,
    taskDefinition: mkTaskDef.arn,
    desiredCount: 1,
    launchType: 'FARGATE',
    networkConfiguration: {
      subnets: privateSubnetIds,
      securityGroups: [servicesSgId],
    },
    serviceRegistries: { registryArn: args.discoveryServices['marketing'].arn },
    loadBalancers: [
      { targetGroupArn: args.targetGroups.marketing.arn, containerName: 'marketing', containerPort: 80 },
    ],
  }, { dependsOn: [args.albListener] })

  return { pgService, psService, kcService, beService, feService, mkService }
}
