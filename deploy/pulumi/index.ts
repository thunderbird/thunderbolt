import * as pulumi from '@pulumi/pulumi'
import { createVpc } from './src/vpc'
import { createEksCluster } from './src/eks'
import { createStorage } from './src/storage'
import { createCluster } from './src/cluster'
import { createServiceDiscovery } from './src/discovery'
import { createAlb } from './src/alb'
import { createServices } from './src/services'

const config = new pulumi.Config()
const stackName = pulumi.getStack()
const name = `tb-${stackName}`
const platform = config.get('platform') || 'fargate'
const version = config.require('version')

// All images are pre-built and published to GHCR by the enterprise-publish workflow
const imagePrefix = 'ghcr.io/thunderbird/thunderbolt'
const images = {
  frontend: `${imagePrefix}/thunderbolt-frontend:${version}`,
  backend: `${imagePrefix}/thunderbolt-backend:${version}`,
  postgres: `${imagePrefix}/thunderbolt-postgres:${version}`,
  keycloak: `${imagePrefix}/thunderbolt-keycloak:${version}`,
  powersync: `${imagePrefix}/thunderbolt-powersync:${version}`,
}

// Secrets with sensible defaults for sandbox (override via `pulumi config set --secret`)
const secrets = {
  postgresPassword: config.getSecret('postgresPassword') ?? pulumi.output('postgres'),
  keycloakAdminPassword: config.getSecret('keycloakAdminPassword') ?? pulumi.output('admin'),
  oidcClientSecret: config.getSecret('oidcClientSecret') ?? pulumi.output('thunderbolt-enterprise-secret'),
  powersyncJwtSecret: config.getSecret('powersyncJwtSecret') ?? pulumi.output('enterprise-powersync-secret'),
}

// Shared: VPC (both platforms need this)
const { vpc, publicSubnets, privateSubnets, albSg, servicesSg } = createVpc(name)

if (platform === 'k8s') {
  // ---------- Kubernetes (EKS) ----------
  const { cluster, lbHostname } = createEksCluster({
    name,
    version,
    vpcId: vpc.id,
    publicSubnetIds: publicSubnets.map((s) => s.id),
    privateSubnetIds: privateSubnets.map((s) => s.id),
    ghcrToken: config.getSecret('ghcrToken'),
  })

  module.exports = {
    platform: 'k8s',
    url: pulumi.interpolate`http://${lbHostname}`,
    kubeconfig: cluster.kubeconfigJson,
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

  const { alb, frontendTg, backendTg, keycloakTg, powersyncTg } = createAlb({
    name,
    vpcId: vpc.id,
    publicSubnetIds: publicSubnets.map((s) => s.id),
    albSgId: albSg.id,
  })

  createServices({
    name,
    cluster,
    logGroup,
    privateSubnetIds: privateSubnets.map((s) => s.id),
    servicesSgId: servicesSg.id,
    efsId: storage.efs.id,
    pgAccessPointId: storage.pgAccessPoint.id,
    mongoAccessPointId: storage.mongoAccessPoint.id,
    images,
    secrets,
    ghcrToken: config.getSecret('ghcrToken'),
    albDnsName: alb.dnsName,
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
    url: pulumi.interpolate`http://${alb.dnsName}`,
    keycloakAdmin: pulumi.interpolate`http://${alb.dnsName}/auth/admin`,
    stackInfo: {
      name: stackName,
      destroy: `pulumi destroy -s ${stackName} -y`,
    },
  }
}
