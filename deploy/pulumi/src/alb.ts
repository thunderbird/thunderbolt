import * as aws from '@pulumi/aws'
import * as pulumi from '@pulumi/pulumi'

type AlbArgs = {
  name: string
  vpcId: pulumi.Input<string>
  publicSubnetIds: pulumi.Input<string>[]
  albSgId: pulumi.Input<string>
}

export const createAlb = ({ name, vpcId, publicSubnetIds, albSgId }: AlbArgs) => {
  const alb = new aws.lb.LoadBalancer(`${name}-alb`, {
    internal: false,
    loadBalancerType: 'application',
    securityGroups: [albSgId],
    subnets: publicSubnetIds,
    tags: { Name: `${name}-alb` },
  })

  // Target groups
  const frontendTg = new aws.lb.TargetGroup(`${name}-frontend-tg`, {
    port: 80,
    protocol: 'HTTP',
    targetType: 'ip',
    vpcId,
    healthCheck: { path: '/', healthyThreshold: 2, interval: 30 },
    tags: { Name: `${name}-frontend` },
  })

  const backendTg = new aws.lb.TargetGroup(`${name}-backend-tg`, {
    port: 8000,
    protocol: 'HTTP',
    targetType: 'ip',
    vpcId,
    healthCheck: { path: '/v1/health', healthyThreshold: 2, interval: 30 },
    tags: { Name: `${name}-backend` },
  })

  const keycloakTg = new aws.lb.TargetGroup(`${name}-keycloak-tg`, {
    port: 8080,
    protocol: 'HTTP',
    targetType: 'ip',
    vpcId,
    healthCheck: { path: '/health/ready', healthyThreshold: 2, interval: 30 },
    tags: { Name: `${name}-keycloak` },
  })

  const powersyncTg = new aws.lb.TargetGroup(`${name}-powersync-tg`, {
    port: 8080,
    protocol: 'HTTP',
    targetType: 'ip',
    vpcId,
    healthCheck: { path: '/', healthyThreshold: 2, interval: 30 },
    tags: { Name: `${name}-powersync` },
  })

  // Listener with path-based routing
  const listener = new aws.lb.Listener(`${name}-listener`, {
    loadBalancerArn: alb.arn,
    port: 80,
    protocol: 'HTTP',
    defaultActions: [{ type: 'forward', targetGroupArn: frontendTg.arn }],
  })

  new aws.lb.ListenerRule(`${name}-backend-rule`, {
    listenerArn: listener.arn,
    priority: 10,
    conditions: [{ pathPattern: { values: ['/v1/*'] } }],
    actions: [{ type: 'forward', targetGroupArn: backendTg.arn }],
  })

  new aws.lb.ListenerRule(`${name}-keycloak-rule`, {
    listenerArn: listener.arn,
    priority: 20,
    conditions: [{ pathPattern: { values: ['/auth/*', '/realms/*'] } }],
    actions: [{ type: 'forward', targetGroupArn: keycloakTg.arn }],
  })

  new aws.lb.ListenerRule(`${name}-powersync-rule`, {
    listenerArn: listener.arn,
    priority: 30,
    conditions: [{ pathPattern: { values: ['/powersync/*'] } }],
    actions: [{ type: 'forward', targetGroupArn: powersyncTg.arn }],
  })

  return { alb, frontendTg, backendTg, keycloakTg, powersyncTg }
}
