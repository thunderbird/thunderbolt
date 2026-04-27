import * as aws from '@pulumi/aws'
import * as pulumi from '@pulumi/pulumi'

type AlbArgs = {
  name: string
  vpcId: pulumi.Input<string>
  publicSubnetIds: pulumi.Input<string>[]
  albSgId: pulumi.Input<string>
  /**
   * Optional host-header routing config. When provided, the ALB adds listener
   * rules that route based on Host header to each service's target group. The
   * existing path-based rules remain as fallback, so enterprise stacks (which
   * don't set hostnames) keep their existing behavior unchanged.
   */
  hostnames?: {
    marketing?: pulumi.Input<string>
    app?: pulumi.Input<string>
    api?: pulumi.Input<string>
    auth?: pulumi.Input<string>
    powersync?: pulumi.Input<string>
  }
}

export const createAlb = ({ name, vpcId, publicSubnetIds, albSgId, hostnames }: AlbArgs) => {
  const alb = new aws.lb.LoadBalancer(`${name}-alb`, {
    internal: false,
    loadBalancerType: 'application',
    securityGroups: [albSgId],
    subnets: publicSubnetIds,
    tags: { Name: `${name}-alb` },
  })

  // Target groups
  //
  // AWS caps Target Group names at 32 chars. Our stack-prefixed names (`tb-preview-pr-N-<svc>-tg`)
  // plus Pulumi's random suffix blow past that limit. Using `namePrefix` (max 6 chars) lets AWS
  // generate a unique short name, while `tags.Name` preserves human-readable stack identification.
  const frontendTg = new aws.lb.TargetGroup(`${name}-frontend-tg`, {
    namePrefix: 'tb-fe',
    port: 80,
    protocol: 'HTTP',
    targetType: 'ip',
    vpcId,
    healthCheck: { path: '/', healthyThreshold: 2, interval: 30 },
    tags: { Name: `${name}-frontend` },
  })

  const backendTg = new aws.lb.TargetGroup(`${name}-backend-tg`, {
    namePrefix: 'tb-be',
    port: 8000,
    protocol: 'HTTP',
    targetType: 'ip',
    vpcId,
    healthCheck: { path: '/v1/health', healthyThreshold: 2, interval: 30 },
    tags: { Name: `${name}-backend` },
  })

  const keycloakTg = new aws.lb.TargetGroup(`${name}-keycloak-tg`, {
    namePrefix: 'tb-kc',
    port: 8080,
    protocol: 'HTTP',
    targetType: 'ip',
    vpcId,
    // Keycloak 26 doesn't serve a welcome page at `/` (404), and /health/* needs
    // KC_HEALTH_ENABLED=true on port 9000. The master realm's OIDC discovery doc
    // is the most reliable always-on indicator once boot completes.
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
    vpcId,
    // PowerSync returns 404 on `/`; use its probes endpoint.
    healthCheck: { path: '/probes/liveness', healthyThreshold: 2, interval: 30 },
    tags: { Name: `${name}-powersync` },
  })

  const marketingTg = new aws.lb.TargetGroup(`${name}-marketing-tg`, {
    namePrefix: 'tb-mk',
    port: 80,
    protocol: 'HTTP',
    targetType: 'ip',
    vpcId,
    healthCheck: { path: '/', healthyThreshold: 2, interval: 30 },
    tags: { Name: `${name}-marketing` },
  })

  // Listener default → frontend (path-based fallback for enterprise stacks)
  const listener = new aws.lb.Listener(`${name}-listener`, {
    loadBalancerArn: alb.arn,
    port: 80,
    protocol: 'HTTP',
    defaultActions: [{ type: 'forward', targetGroupArn: frontendTg.arn }],
  })

  // -- Host-header rules (priority 1-5) — active only when hostnames provided.
  // These win over path-based rules because lower priority = higher precedence.
  if (hostnames?.marketing) {
    new aws.lb.ListenerRule(`${name}-host-marketing-rule`, {
      listenerArn: listener.arn,
      priority: 1,
      conditions: [{ hostHeader: { values: [hostnames.marketing] } }],
      actions: [{ type: 'forward', targetGroupArn: marketingTg.arn }],
    })
  }

  if (hostnames?.app) {
    new aws.lb.ListenerRule(`${name}-host-app-rule`, {
      listenerArn: listener.arn,
      priority: 2,
      conditions: [{ hostHeader: { values: [hostnames.app] } }],
      actions: [{ type: 'forward', targetGroupArn: frontendTg.arn }],
    })
  }

  if (hostnames?.api) {
    new aws.lb.ListenerRule(`${name}-host-api-rule`, {
      listenerArn: listener.arn,
      priority: 3,
      conditions: [{ hostHeader: { values: [hostnames.api] } }],
      actions: [{ type: 'forward', targetGroupArn: backendTg.arn }],
    })
  }

  if (hostnames?.auth) {
    new aws.lb.ListenerRule(`${name}-host-auth-rule`, {
      listenerArn: listener.arn,
      priority: 4,
      conditions: [{ hostHeader: { values: [hostnames.auth] } }],
      actions: [{ type: 'forward', targetGroupArn: keycloakTg.arn }],
    })
  }

  if (hostnames?.powersync) {
    new aws.lb.ListenerRule(`${name}-host-powersync-rule`, {
      listenerArn: listener.arn,
      priority: 5,
      conditions: [{ hostHeader: { values: [hostnames.powersync] } }],
      actions: [{ type: 'forward', targetGroupArn: powersyncTg.arn }],
    })
  }

  // -- Path-based rules (priority 10-30) — enterprise stack fallback.
  // Kept for backwards compat; served when no host-header rule matches.
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

  return { alb, listener, frontendTg, backendTg, keycloakTg, powersyncTg, marketingTg }
}
