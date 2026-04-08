import * as aws from '@pulumi/aws'
import * as command from '@pulumi/command'
import * as pulumi from '@pulumi/pulumi'

type Images = {
  frontend: string
  backend: string
  postgres: string
  keycloak: string
  powersync: string
}

type Secrets = {
  postgresPassword: pulumi.Output<string>
  keycloakAdminPassword: pulumi.Output<string>
  oidcClientSecret: pulumi.Output<string>
  powersyncJwtSecret: pulumi.Output<string>
}

type ServiceArgs = {
  name: string
  cluster: aws.ecs.Cluster
  logGroup: aws.cloudwatch.LogGroup
  privateSubnetIds: pulumi.Input<string>[]
  servicesSgId: pulumi.Input<string>
  efsId: pulumi.Input<string>
  pgAccessPointId: pulumi.Input<string>
  mongoAccessPointId: pulumi.Input<string>
  images: Images
  secrets: Secrets
  ghcrToken?: pulumi.Output<string>
  albDnsName: pulumi.Input<string>
  targetGroups: {
    frontend: aws.lb.TargetGroup
    backend: aws.lb.TargetGroup
    keycloak: aws.lb.TargetGroup
    powersync: aws.lb.TargetGroup
  }
  discoveryServices: Record<string, aws.servicediscovery.Service>
}

export const createServices = (args: ServiceArgs) => {
  const { name, cluster, logGroup, privateSubnetIds, servicesSgId, efsId, pgAccessPointId, mongoAccessPointId } = args
  const region = aws.getRegionOutput().name

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

  // --- GHCR registry auth (for pulling private images) ---
  let repositoryCredentials: { credentialsParameter: pulumi.Output<string> } | undefined

  if (args.ghcrToken) {
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

    repositoryCredentials = { credentialsParameter: ghcrSecret.arn }
  }

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
        command: ['postgres', '-c', 'wal_level=logical'],
        environment: [
          { name: 'POSTGRES_USER', value: 'postgres' },
          { name: 'POSTGRES_DB', value: 'postgres' },
          { name: 'POSTGRES_PASSWORD', value: args.secrets.postgresPassword },
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
    networkConfiguration: {
      subnets: privateSubnetIds,
      securityGroups: [servicesSgId],
    },
    serviceRegistries: { registryArn: args.discoveryServices['postgres'].arn },
  })

  // --- MongoDB ---
  const mongoTaskDef = new aws.ecs.TaskDefinition(`${name}-mongo-task`, {
    family: `${name}-mongo`,
    requiresCompatibilities: ['FARGATE'],
    networkMode: 'awsvpc',
    cpu: '512',
    memory: '1024',
    executionRoleArn: execRoleArn,
    taskRoleArn,
    volumes: [
      {
        name: 'mongo-data',
        efsVolumeConfiguration: {
          fileSystemId: efsId,
          transitEncryption: 'ENABLED',
          authorizationConfig: { accessPointId: mongoAccessPointId, iam: 'ENABLED' },
        },
      },
    ],
    containerDefinitions: pulumi.jsonStringify([
      {
        name: 'mongo',
        image: 'mongo:7.0',
        essential: true,
        command: ['--replSet', 'rs0', '--bind_ip_all', '--quiet'],
        portMappings: [{ containerPort: 27017 }],
        mountPoints: [{ sourceVolume: 'mongo-data', containerPath: '/data/db' }],
        logConfiguration: logConfig('mongo'),
      },
    ]),
  })

  const mongoService = new aws.ecs.Service(`${name}-mongo-svc`, {
    cluster: cluster.arn,
    taskDefinition: mongoTaskDef.arn,
    desiredCount: 1,
    launchType: 'FARGATE',
    networkConfiguration: {
      subnets: privateSubnetIds,
      securityGroups: [servicesSgId],
    },
    serviceRegistries: { registryArn: args.discoveryServices['mongo'].arn },
  })

  // --- MongoDB replica set init (one-shot task) ---
  const mongoInitTaskDef = new aws.ecs.TaskDefinition(`${name}-mongo-init-task`, {
    family: `${name}-mongo-init`,
    requiresCompatibilities: ['FARGATE'],
    networkMode: 'awsvpc',
    cpu: '256',
    memory: '512',
    executionRoleArn: execRoleArn,
    taskRoleArn,
    containerDefinitions: pulumi.jsonStringify([
      {
        name: 'mongo-init',
        image: 'mongo:7.0',
        essential: true,
        command: [
          'mongosh',
          '--host', 'mongo.thunderbolt.local',
          '--eval',
          'try { rs.status() } catch(e) { rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "mongo.thunderbolt.local:27017" }] }) }',
        ],
        logConfiguration: logConfig('mongo-init'),
      },
    ]),
  })

  // Run the mongo init task after the mongo service is healthy
  const mongoInit = new command.local.Command(
    `${name}-mongo-init-run`,
    {
      create: pulumi.interpolate`aws ecs run-task \
        --cluster ${cluster.arn} \
        --task-definition ${mongoInitTaskDef.arn} \
        --launch-type FARGATE \
        --network-configuration '{"awsvpcConfiguration":{"subnets":${pulumi.jsonStringify(privateSubnetIds)},"securityGroups":["${servicesSgId}"]}}' \
        --query 'tasks[0].taskArn' --output text`,
    },
    { dependsOn: [mongoService] },
  )

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
    networkConfiguration: {
      subnets: privateSubnetIds,
      securityGroups: [servicesSgId],
    },
    serviceRegistries: { registryArn: args.discoveryServices['powersync'].arn },
    loadBalancers: [
      { targetGroupArn: args.targetGroups.powersync.arn, containerName: 'powersync', containerPort: 8080 },
    ],
  })

  // --- Keycloak ---
  const kcTaskDef = new aws.ecs.TaskDefinition(`${name}-kc-task`, {
    family: `${name}-keycloak`,
    requiresCompatibilities: ['FARGATE'],
    networkMode: 'awsvpc',
    cpu: '1024',
    memory: '2048',
    executionRoleArn: execRoleArn,
    taskRoleArn,
    containerDefinitions: pulumi.all([args.albDnsName, args.secrets.keycloakAdminPassword]).apply(([dns, kcPassword]) =>
      JSON.stringify([
        {
          name: 'keycloak',
          image: args.images.keycloak,
          essential: true,
          command: ['start-dev', '--import-realm'],
          environment: [
            { name: 'KC_BOOTSTRAP_ADMIN_USERNAME', value: 'admin' },
            { name: 'KC_BOOTSTRAP_ADMIN_PASSWORD', value: kcPassword },
            { name: 'KC_HTTP_PORT', value: '8080' },
            { name: 'KC_HOSTNAME_URL', value: `http://${dns}` },
            { name: 'KC_HTTP_RELATIVE_PATH', value: '/auth' },
          ],
          portMappings: [{ containerPort: 8080 }],
          logConfiguration: logConfig('keycloak'),
          ...(repositoryCredentials && { repositoryCredentials }),
        },
      ]),
    ),
  })

  const kcService = new aws.ecs.Service(`${name}-kc-svc`, {
    cluster: cluster.arn,
    taskDefinition: kcTaskDef.arn,
    desiredCount: 1,
    launchType: 'FARGATE',
    networkConfiguration: {
      subnets: privateSubnetIds,
      securityGroups: [servicesSgId],
    },
    serviceRegistries: { registryArn: args.discoveryServices['keycloak'].arn },
    loadBalancers: [
      { targetGroupArn: args.targetGroups.keycloak.arn, containerName: 'keycloak', containerPort: 8080 },
    ],
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
    containerDefinitions: pulumi
      .all([args.albDnsName, args.secrets.postgresPassword, args.secrets.oidcClientSecret, args.secrets.powersyncJwtSecret])
      .apply(([dns, pgPassword, oidcSecret, psSecret]) =>
        JSON.stringify([
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
              { name: 'DATABASE_URL', value: `postgresql://postgres:${pgPassword}@postgres.thunderbolt.local:5432/postgres` },
              { name: 'OIDC_ISSUER', value: `http://${dns}/auth/realms/thunderbolt` },
              { name: 'OIDC_CLIENT_ID', value: 'thunderbolt-app' },
              { name: 'OIDC_CLIENT_SECRET', value: oidcSecret },
              { name: 'BETTER_AUTH_URL', value: `http://${dns}` },
              { name: 'APP_URL', value: `http://${dns}` },
              { name: 'TRUSTED_ORIGINS', value: `http://${dns}` },
              { name: 'CORS_ORIGINS', value: `http://${dns}` },
              { name: 'CORS_ORIGIN_REGEX', value: '' },
              { name: 'POWERSYNC_URL', value: `http://${dns}/powersync` },
              { name: 'POWERSYNC_JWT_SECRET', value: psSecret },
              { name: 'POWERSYNC_JWT_KID', value: 'enterprise-powersync' },
              { name: 'RATE_LIMIT_ENABLED', value: 'true' },
            ],
            portMappings: [{ containerPort: 8000 }],
            logConfiguration: logConfig('backend'),
            ...(repositoryCredentials && { repositoryCredentials }),
          },
        ]),
      ),
  })

  const beService = new aws.ecs.Service(`${name}-be-svc`, {
    cluster: cluster.arn,
    taskDefinition: beTaskDef.arn,
    desiredCount: 1,
    launchType: 'FARGATE',
    networkConfiguration: {
      subnets: privateSubnetIds,
      securityGroups: [servicesSgId],
    },
    serviceRegistries: { registryArn: args.discoveryServices['backend'].arn },
    loadBalancers: [
      { targetGroupArn: args.targetGroups.backend.arn, containerName: 'backend', containerPort: 8000 },
    ],
  })

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
  })

  return { pgService, mongoService, mongoInit, psService, kcService, beService, feService }
}
