/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Cloud runner infrastructure (see `cloud-runner/` for the service).
 *
 * Topology: browser (wss) → CloudFront (default *.cloudfront.net cert; the
 * account has no Route53 zone/ACM cert, and CloudFront is the supported way to
 * terminate TLS without one) → ALB (HTTP :80, idle timeout 3600s) → ECS
 * Fargate task (:8080, ARM64) with EFS mounted at /data for session logs.
 * The runner sends WS pings every 25s, clearing CloudFront's non-adjustable
 * 10-minute idle cap and the ALB timeout with margin.
 *
 * Exactly one task, deliberately: the runner owns its sessions in process
 * memory and writes their logs to the shared EFS volume, so two tasks would
 * race each other. The service is therefore single-instance in V1 — see the
 * ECS service below and `cloud-runner/README.md`.
 *
 * The container image is built (linux/arm64) and pushed to ECR by Pulumi
 * itself from the repository root Dockerfile.
 *
 * Config:
 *   backendUrl (required) — Thunderbolt backend origin; used both for bearer
 *                           introspection and as the inference gateway host
 *                           (the runner holds no provider keys)
 *
 * No model configuration exists here: clients send the model and reasoning
 * depth with every session and turn.
 */

import * as aws from '@pulumi/aws'
import * as dockerBuild from '@pulumi/docker-build'
import * as pulumi from '@pulumi/pulumi'

const name = 'tb-cloud-runner'
const config = new pulumi.Config()
const backendUrl = config.require('backendUrl')

const containerPort = 8080

// --- Network (account default VPC; public subnets, no NAT) ---
const vpc = aws.ec2.getVpcOutput({ default: true })
const subnets = aws.ec2.getSubnetsOutput({
  filters: [
    { name: 'vpc-id', values: [vpc.id] },
    { name: 'default-for-az', values: ['true'] },
  ],
})

// Only CloudFront's origin-facing ranges may reach the ALB.
const cloudfrontPrefixList = aws.ec2.getManagedPrefixListOutput({ name: 'com.amazonaws.global.cloudfront.origin-facing' })

const albSg = new aws.ec2.SecurityGroup(`${name}-alb-sg`, {
  vpcId: vpc.id,
  ingress: [{ protocol: 'tcp', fromPort: 80, toPort: 80, prefixListIds: [cloudfrontPrefixList.id] }],
  egress: [{ protocol: '-1', fromPort: 0, toPort: 0, cidrBlocks: ['0.0.0.0/0'] }],
  tags: { Name: `${name}-alb-sg` },
})

const taskSg = new aws.ec2.SecurityGroup(`${name}-task-sg`, {
  vpcId: vpc.id,
  ingress: [{ protocol: 'tcp', fromPort: containerPort, toPort: containerPort, securityGroups: [albSg.id] }],
  egress: [{ protocol: '-1', fromPort: 0, toPort: 0, cidrBlocks: ['0.0.0.0/0'] }],
  tags: { Name: `${name}-task-sg` },
})

const efsSg = new aws.ec2.SecurityGroup(`${name}-efs-sg`, {
  vpcId: vpc.id,
  ingress: [{ protocol: 'tcp', fromPort: 2049, toPort: 2049, securityGroups: [taskSg.id] }],
  tags: { Name: `${name}-efs-sg` },
})

// --- Durable session storage ---
const efs = new aws.efs.FileSystem(`${name}-efs`, {
  encrypted: true,
  tags: { Name: `${name}-efs` },
})

const mountTargets = subnets.ids.apply((ids) =>
  ids.map(
    (subnetId, i) =>
      new aws.efs.MountTarget(`${name}-efs-mt-${i}`, {
        fileSystemId: efs.id,
        subnetId,
        securityGroups: [efsSg.id],
      }),
  ),
)

const accessPoint = new aws.efs.AccessPoint(`${name}-efs-ap`, {
  fileSystemId: efs.id,
  posixUser: { uid: 1000, gid: 1000 },
  rootDirectory: { path: '/runner', creationInfo: { ownerUid: 1000, ownerGid: 1000, permissions: '755' } },
})

// --- Image (built by Pulumi, pushed to ECR) ---
const repo = new aws.ecr.Repository(`${name}-repo`, {
  name,
  forceDelete: true,
  imageTagMutability: 'MUTABLE',
})

const ecrAuth = aws.ecr.getAuthorizationTokenOutput({ registryId: repo.registryId })

const image = new dockerBuild.Image(`${name}-image`, {
  context: { location: '../..' },
  dockerfile: { location: '../docker/cloud-runner.Dockerfile' },
  platforms: ['linux/arm64'],
  push: true,
  tags: [pulumi.interpolate`${repo.repositoryUrl}:latest`],
  registries: [
    {
      address: ecrAuth.proxyEndpoint,
      username: ecrAuth.userName,
      password: ecrAuth.password,
    },
  ],
})

// --- ECS ---
const cluster = new aws.ecs.Cluster(`${name}-cluster`, { name })
const logGroup = new aws.cloudwatch.LogGroup(`${name}-logs`, { name: `/ecs/${name}`, retentionInDays: 30 })

const execRole = new aws.iam.Role(`${name}-exec-role`, {
  assumeRolePolicy: JSON.stringify({
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Principal: { Service: 'ecs-tasks.amazonaws.com' }, Action: 'sts:AssumeRole' }],
  }),
  managedPolicyArns: ['arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy'],
})

const taskRole = new aws.iam.Role(`${name}-task-role`, {
  assumeRolePolicy: JSON.stringify({
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Principal: { Service: 'ecs-tasks.amazonaws.com' }, Action: 'sts:AssumeRole' }],
  }),
})

new aws.iam.RolePolicy(`${name}-task-efs-policy`, {
  role: taskRole.name,
  policy: pulumi.jsonStringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite'],
        Resource: [efs.arn],
      },
    ],
  }),
})

const region = aws.getRegionOutput().region

const taskDefinition = new aws.ecs.TaskDefinition(`${name}-task`, {
  family: name,
  requiresCompatibilities: ['FARGATE'],
  networkMode: 'awsvpc',
  cpu: '512',
  memory: '1024',
  runtimePlatform: { cpuArchitecture: 'ARM64', operatingSystemFamily: 'LINUX' },
  executionRoleArn: execRole.arn,
  taskRoleArn: taskRole.arn,
  volumes: [
    {
      name: 'data',
      efsVolumeConfiguration: {
        fileSystemId: efs.id,
        transitEncryption: 'ENABLED',
        authorizationConfig: { accessPointId: accessPoint.id, iam: 'ENABLED' },
      },
    },
  ],
  containerDefinitions: pulumi.jsonStringify([
    {
      name: 'cloud-runner',
      image: image.ref,
      essential: true,
      portMappings: [{ containerPort, protocol: 'tcp' }],
      environment: [
        { name: 'BACKEND_URL', value: backendUrl },
        { name: 'CLOUD_RUNNER_DATA_DIR', value: '/data' },
      ],
      mountPoints: [{ sourceVolume: 'data', containerPath: '/data' }],
      logConfiguration: {
        logDriver: 'awslogs',
        options: {
          'awslogs-group': logGroup.name,
          'awslogs-region': region,
          'awslogs-stream-prefix': 'cloud-runner',
        },
      },
    },
  ]),
})

// --- ALB ---
const alb = new aws.lb.LoadBalancer(`${name}-alb`, {
  loadBalancerType: 'application',
  securityGroups: [albSg.id],
  subnets: subnets.ids,
  // WebSockets between turns are quiet; keep the hop from reaping them (the
  // runner pings every 25s regardless).
  idleTimeout: 3600,
  tags: { Name: `${name}-alb` },
})

const targetGroup = new aws.lb.TargetGroup(`${name}-tg`, {
  vpcId: vpc.id,
  port: containerPort,
  protocol: 'HTTP',
  targetType: 'ip',
  healthCheck: { path: '/healthz', matcher: '200', interval: 15, healthyThreshold: 2 },
  deregistrationDelay: 60,
})

const listener = new aws.lb.Listener(`${name}-listener`, {
  loadBalancerArn: alb.arn,
  port: 80,
  protocol: 'HTTP',
  defaultActions: [{ type: 'forward', targetGroupArn: targetGroup.arn }],
})

const service = new aws.ecs.Service(
  `${name}-service`,
  {
    name,
    cluster: cluster.arn,
    taskDefinition: taskDefinition.arn,
    // Single-task ownership is a correctness requirement, not a cost choice:
    // sessions live in one process's memory over a shared EFS volume. The
    // deployment window stops a rolling update from ever running two tasks at
    // once — the new one starts only after the old one is gone, which costs a
    // short outage and ends in-flight turns (clients resume and re-prompt).
    desiredCount: 1,
    deploymentMaximumPercent: 100,
    deploymentMinimumHealthyPercent: 0,
    launchType: 'FARGATE',
    networkConfiguration: {
      subnets: subnets.ids,
      securityGroups: [taskSg.id],
      assignPublicIp: true,
    },
    loadBalancers: [{ targetGroupArn: targetGroup.arn, containerName: 'cloud-runner', containerPort }],
    waitForSteadyState: false,
  },
  { dependsOn: mountTargets.apply((targets) => [listener as pulumi.Resource, ...targets]) },
)

// --- CloudFront (TLS termination with the default *.cloudfront.net cert) ---
const distribution = new aws.cloudfront.Distribution(`${name}-cdn`, {
  enabled: true,
  priceClass: 'PriceClass_100',
  origins: [
    {
      originId: 'alb',
      domainName: alb.dnsName,
      customOriginConfig: {
        httpPort: 80,
        httpsPort: 443,
        originProtocolPolicy: 'http-only',
        originSslProtocols: ['TLSv1.2'],
        originReadTimeout: 60,
        originKeepaliveTimeout: 60,
      },
    },
  ],
  defaultCacheBehavior: {
    targetOriginId: 'alb',
    viewerProtocolPolicy: 'redirect-to-https',
    allowedMethods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'POST', 'PATCH', 'DELETE'],
    cachedMethods: ['GET', 'HEAD'],
    // Managed policies: CachingDisabled + AllViewer (forwards the WebSocket
    // upgrade headers, including Sec-WebSocket-Protocol carrying the bearer).
    cachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad',
    originRequestPolicyId: '216adef6-5c7f-47e4-b989-5492eafa07d3',
  },
  restrictions: { geoRestriction: { restrictionType: 'none' } },
  viewerCertificate: { cloudfrontDefaultCertificate: true },
})

export const albDns = alb.dnsName
export const cloudfrontDomain = distribution.domainName
/** Value for the backend's CLOUD_RUNNER_WS_URL. */
export const wsUrl = pulumi.interpolate`wss://${distribution.domainName}/`
export const serviceName = service.name
export const imageRef = image.ref
