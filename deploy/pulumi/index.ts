import * as pulumi from '@pulumi/pulumi'
import { createVpc } from './src/vpc'
import { createEcrAndImages } from './src/ecr'

const config = new pulumi.Config()
const stackName = pulumi.getStack()
const name = `tb-${stackName}`
const platform = config.get('platform') || 'fargate'

// Shared: VPC + ECR images (both platforms need these)
const { vpc, publicSubnets, privateSubnets, albSg, servicesSg } = createVpc(name)
const { backendRepo, frontendRepo, postgresRepo, keycloakRepo, powersyncRepo } = createEcrAndImages(name)

if (platform === 'k8s') {
  // ---------- Kubernetes (EKS) ----------
  const { createEksCluster } = require('./src/eks')

  const { cluster, lbHostname } = createEksCluster({
    name,
    vpcId: vpc.id,
    publicSubnetIds: publicSubnets.map((s) => s.id),
    privateSubnetIds: privateSubnets.map((s) => s.id),
    backendImageUri: backendRepo.repositoryUrl.apply((url: string) => `${url}:latest`),
    frontendImageUri: frontendRepo.repositoryUrl.apply((url: string) => `${url}:latest`),
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
  const { createStorage } = require('./src/storage')
  const { createCluster } = require('./src/cluster')
  const { createServiceDiscovery } = require('./src/discovery')
  const { createAlb } = require('./src/alb')
  const { createServices } = require('./src/services')

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
    backendImageUri: backendRepo.repositoryUrl.apply((url: string) => `${url}:latest`),
    frontendImageUri: frontendRepo.repositoryUrl.apply((url: string) => `${url}:latest`),
    postgresImageUri: postgresRepo.repositoryUrl.apply((url: string) => `${url}:latest`),
    keycloakImageUri: keycloakRepo.repositoryUrl.apply((url: string) => `${url}:latest`),
    powersyncImageUri: powersyncRepo.repositoryUrl.apply((url: string) => `${url}:latest`),
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
