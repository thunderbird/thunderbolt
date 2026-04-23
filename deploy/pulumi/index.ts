import * as pulumi from '@pulumi/pulumi'
import { createVpc } from './src/vpc'
import { createEksCluster } from './src/eks'
import { createStorage } from './src/storage'
import { createCluster } from './src/cluster'
import { createServiceDiscovery } from './src/discovery'
import { createAlb } from './src/alb'
import { createServices } from './src/services'
import { createDns } from './src/dns'

const config = new pulumi.Config()
const stackName = pulumi.getStack()
const name = `tb-${stackName}`
const platform = config.get('platform') || 'fargate'
const version = config.require('version')

// Optional Cloudflare subdomain wiring (used by preview-pr-* stacks).
// Accepts either `subdomain` (single hostname, back-compat) or `hostnames`
// (comma-separated list — the first is primary and becomes publicUrl, the
// rest are additional CNAMEs pointing at the same ALB for multi-subdomain
// setups like `app-pr-N` + `api-pr-N` + `pr-N`).
// When set, Pulumi creates proxied CNAMEs in Cloudflare and uses https://<primary>
// instead of the raw ALB DNS. Enterprise stacks leave this unset.
const hostnames = (config.get('hostnames') ?? config.get('subdomain') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0)
const cloudflareZoneId = config.get('cloudflareZoneId')
const cloudflareApiToken = config.getSecret('cloudflareApiToken')

if (hostnames.length > 0 && (!cloudflareZoneId || !cloudflareApiToken)) {
  throw new Error(
    'hostnames/subdomain is set but cloudflareZoneId and/or cloudflareApiToken are missing — ' +
      'run `pulumi config set cloudflareZoneId <id>` and `pulumi config set --secret cloudflareApiToken <token>`',
  )
}

// All images are pre-built and published to GHCR by the enterprise-publish workflow
const imagePrefix = 'ghcr.io/thunderbird/thunderbolt'
const images = {
  frontend: `${imagePrefix}/thunderbolt-frontend:${version}`,
  backend: `${imagePrefix}/thunderbolt-backend:${version}`,
  postgres: `${imagePrefix}/thunderbolt-postgres:${version}`,
  keycloak: `${imagePrefix}/thunderbolt-keycloak:${version}`,
  powersync: `${imagePrefix}/thunderbolt-powersync:${version}`,
}

// Secrets — override per-stack via `pulumi config set --secret <key> <value>`
const secrets = {
  postgresPassword: config.getSecret('postgresPassword') ?? pulumi.output('postgres'),
  keycloakAdminPassword: config.getSecret('keycloakAdminPassword') ?? pulumi.output('admin'),
  oidcClientSecret: config.getSecret('oidcClientSecret') ?? pulumi.output('thunderbolt-enterprise-secret'),
  powersyncJwtSecret: config.getSecret('powersyncJwtSecret') ?? pulumi.output('enterprise-thunderbolt-powersync-jwt-default-secret'),
  betterAuthSecret: config.getSecret('betterAuthSecret') ?? pulumi.output('enterprise-thunderbolt-better-auth-default-secret'),
  powersyncDbPassword: config.getSecret('powersyncDbPassword') ?? pulumi.output('myhighlyrandompassword'),
}

// Shared: VPC (both platforms need this)
const { vpc, publicSubnets, privateSubnets, albSg, servicesSg } = createVpc(name)

if (platform === 'k8s') {
  // ---------- Kubernetes (EKS) ----------
  const appUrl = config.get('appUrl') || 'http://localhost'
  const { cluster } = createEksCluster({
    name,
    version,
    imagePrefix,
    appUrl,
    vpcId: vpc.id,
    publicSubnetIds: publicSubnets.map((s) => s.id),
    privateSubnetIds: privateSubnets.map((s) => s.id),
    ghcrToken: config.getSecret('ghcrToken'),
    betterAuthSecretBase64: secrets.betterAuthSecret.apply((s) => Buffer.from(s).toString('base64')),
  })

  module.exports = {
    platform: 'k8s',
    kubeconfig: cluster.kubeconfigJson,
    note: 'Run: kubectl get svc -n ingress-nginx ingress-nginx-controller -o jsonpath="{.status.loadBalancer.ingress[0].hostname}" to get the URL',
    stackInfo: {
      name: stackName,
      destroy: `pulumi destroy -s ${stackName} -y`,
    },
  }
} else {
  // ---------- Fargate (ECS) ----------
  const storage = createStorage(
    name,
    vpc.id,
    privateSubnets.map((s) => s.id),
    servicesSg.id,
  )

  const { cluster, logGroup } = createCluster(name)
  const { services: discoveryServices } = createServiceDiscovery(name, vpc.id)

  const { alb, listener, frontendTg, backendTg, keycloakTg, powersyncTg } = createAlb({
    name,
    vpcId: vpc.id,
    publicSubnetIds: publicSubnets.map((s) => s.id),
    albSgId: albSg.id,
  })

  // If hostnames are configured, create a Cloudflare CNAME per hostname and derive
  // the public URL from the first (primary). Otherwise fall back to the raw ALB hostname.
  const dns = hostnames.length > 0
    ? createDns({
        name,
        zoneId: cloudflareZoneId!,
        hostnames,
        target: alb.dnsName,
        apiToken: cloudflareApiToken!,
      })
    : undefined

  const publicUrl = dns ? dns.url : pulumi.interpolate`http://${alb.dnsName}`

  createServices({
    name,
    cluster,
    logGroup,
    privateSubnetIds: privateSubnets.map((s) => s.id),
    servicesSgId: servicesSg.id,
    efsId: storage.efs.id,
    pgAccessPointId: storage.pgAccessPoint.id,
    images,
    secrets,
    ghcrToken: config.getSecret('ghcrToken'),
    publicUrl,
    albListener: listener,
    targetGroups: {
      frontend: frontendTg,
      backend: backendTg,
      keycloak: keycloakTg,
      powersync: powersyncTg,
    },
    discoveryServices,
  })

  module.exports = {
    platform: 'fargate',
    url: publicUrl,
    albDnsName: alb.dnsName,
    keycloakAdmin: pulumi.interpolate`${publicUrl}/auth/admin`,
    stackInfo: {
      name: stackName,
      destroy: `pulumi destroy -s ${stackName} -y`,
    },
  }
}
