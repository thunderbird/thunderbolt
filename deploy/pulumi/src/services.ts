import * as aws from '@pulumi/aws'
import * as pulumi from '@pulumi/pulumi'

type ServiceArgs = {
  name: string
  cluster: aws.ecs.Cluster
  logGroup: aws.cloudwatch.LogGroup
  privateSubnetIds: pulumi.Input<string>[]
  servicesSgId: pulumi.Input<string>
  efsId: pulumi.Input<string>
  pgAccessPointId: pulumi.Input<string>
  mongoAccessPointId: pulumi.Input<string>
  backendImageUri: pulumi.Input<string>
  frontendImageUri: pulumi.Input<string>
  postgresImageUri: pulumi.Input<string>
  keycloakImageUri: pulumi.Input<string>
  powersyncImageUri: pulumi.Input<string>
  albDnsName: pulumi.Input<string>
  targetGroups: {
    frontend: aws.lb.TargetGroup
    backend: aws.lb.TargetGroup
    keycloak: aws.lb.TargetGroup
    powersync: aws.lb.TargetGroup
  }
  discoveryServices: Record<string, aws.servicediscovery.Service>
}

const execRole = (name: string) =>
  new aws.iam.Role(`${name}-exec-role`, {
    assumeRolePolicy: JSON.stringify({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Principal: { Service: 'ecs-tasks.amazonaws.com' }, Action: 'sts:AssumeRole' }],
    }),
    managedPolicyArns: ['arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy'],
    tags: { Name: `${name}-exec-role` },
  })

const taskRole = (name: string) =>
  new aws.iam.Role(`${name}-task-role`, {
    assumeRolePolicy: JSON.stringify({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Principal: { Service: 'ecs-tasks.amazonaws.com' }, Action: 'sts:AssumeRole' }],
    }),
    tags: { Name: `${name}-task-role` },
  })

export const createServices = (args: ServiceArgs) => {
  const { name, cluster, logGroup, privateSubnetIds, servicesSgId, efsId, pgAccessPointId, mongoAccessPointId } = args
  const region = aws.getRegionOutput().name
  const execRoleArn = execRole(name).arn
  const taskRoleArn = taskRole(name).arn

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
    containerDefinitions: pulumi.all([args.postgresImageUri]).apply(([imageUri]) => JSON.stringify([
      {
        name: 'postgres',
        image: imageUri,
        essential: true,
        command: ['postgres', '-c', 'wal_level=logical'],
        environment: [
          { name: 'POSTGRES_USER', value: 'postgres' },
          { name: 'POSTGRES_DB', value: 'postgres' },
          { name: 'POSTGRES_PASSWORD', value: 'postgres' },
        ],
        portMappings: [{ containerPort: 5432 }],
        mountPoints: [{ sourceVolume: 'pg-data', containerPath: '/var/lib/postgresql/data' }],
        logConfiguration: logConfig('postgres'),
      },
    ])),
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
        image: 'mongo:7.0', // no custom config needed, use official image
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

  // --- PowerSync ---
  const psTaskDef = new aws.ecs.TaskDefinition(`${name}-ps-task`, {
    family: `${name}-powersync`,
    requiresCompatibilities: ['FARGATE'],
    networkMode: 'awsvpc',
    cpu: '512',
    memory: '1024',
    executionRoleArn: execRoleArn,
    taskRoleArn,
    containerDefinitions: pulumi.all([args.powersyncImageUri]).apply(([imageUri]) => JSON.stringify([
      {
        name: 'powersync',
        image: imageUri,
        essential: true,
        command: ['start', '-r', 'unified'],
        environment: [{ name: 'POWERSYNC_CONFIG_PATH', value: '/config/config.yaml' }],
        portMappings: [{ containerPort: 8080 }],
        logConfiguration: logConfig('powersync'),
      },
    ])),
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
    containerDefinitions: pulumi.all([args.keycloakImageUri, args.albDnsName]).apply(([imageUri, dns]) =>
      JSON.stringify([
        {
          name: 'keycloak',
          image: imageUri,
          essential: true,
          command: ['start-dev', '--import-realm'],
          environment: [
            { name: 'KC_BOOTSTRAP_ADMIN_USERNAME', value: 'admin' },
            { name: 'KC_BOOTSTRAP_ADMIN_PASSWORD', value: 'admin' },
            { name: 'KC_HTTP_PORT', value: '8080' },
            { name: 'KC_HOSTNAME_URL', value: `http://${dns}` },
            { name: 'KC_HTTP_RELATIVE_PATH', value: '/auth' },
          ],
          portMappings: [{ containerPort: 8080 }],
          logConfiguration: {
            logDriver: 'awslogs',
            options: {
              'awslogs-group': name + '-logs',
              'awslogs-region': 'us-east-1', // will be overridden
              'awslogs-stream-prefix': 'keycloak',
            },
          },
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
    containerDefinitions: pulumi.all([args.backendImageUri, args.albDnsName]).apply(([imageUri, dns]) =>
      JSON.stringify([
        {
          name: 'backend',
          image: imageUri,
          essential: true,
          environment: [
            { name: 'NODE_ENV', value: 'production' },
            { name: 'PORT', value: '8000' },
            { name: 'AUTH_MODE', value: 'oidc' },
            { name: 'WAITLIST_ENABLED', value: 'false' },
            { name: 'DATABASE_DRIVER', value: 'postgres' },
            { name: 'DATABASE_URL', value: 'postgresql://postgres:postgres@postgres.thunderbolt.local:5432/postgres' },
            { name: 'OIDC_ISSUER', value: `http://${dns}/auth/realms/thunderbolt` },
            { name: 'OIDC_CLIENT_ID', value: 'thunderbolt-app' },
            { name: 'OIDC_CLIENT_SECRET', value: 'thunderbolt-enterprise-secret' },
            { name: 'BETTER_AUTH_URL', value: `http://${dns}` },
            { name: 'APP_URL', value: `http://${dns}` },
            { name: 'TRUSTED_ORIGINS', value: `http://${dns}` },
            { name: 'CORS_ORIGINS', value: `http://${dns}` },
            { name: 'POWERSYNC_URL', value: `http://${dns}/powersync` },
            { name: 'POWERSYNC_JWT_SECRET', value: 'enterprise-powersync-secret' },
            { name: 'POWERSYNC_JWT_KID', value: 'enterprise-powersync' },
            { name: 'RATE_LIMIT_ENABLED', value: 'true' },
          ],
          portMappings: [{ containerPort: 8000 }],
          logConfiguration: {
            logDriver: 'awslogs',
            options: {
              'awslogs-group': name + '-logs',
              'awslogs-region': 'us-east-1',
              'awslogs-stream-prefix': 'backend',
            },
          },
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
    containerDefinitions: pulumi.all([args.frontendImageUri]).apply(([imageUri]) =>
      JSON.stringify([
        {
          name: 'frontend',
          image: imageUri,
          essential: true,
          portMappings: [{ containerPort: 80 }],
          logConfiguration: {
            logDriver: 'awslogs',
            options: {
              'awslogs-group': name + '-logs',
              'awslogs-region': 'us-east-1',
              'awslogs-stream-prefix': 'frontend',
            },
          },
        },
      ]),
    ),
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

  return { pgService, mongoService, psService, kcService, beService, feService }
}
