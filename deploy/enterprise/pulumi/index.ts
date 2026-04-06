import * as pulumi from '@pulumi/pulumi'
import { createVpc } from './src/vpc'
import { createStorage } from './src/storage'
import { createCluster } from './src/cluster'
import { createServiceDiscovery } from './src/discovery'
import { createEcrAndImages } from './src/ecr'
import { createAlb } from './src/alb'
import { createServices } from './src/services'

const config = new pulumi.Config()
const stackName = pulumi.getStack()
const name = `tb-${stackName}`

// 1. VPC + networking
const { vpc, publicSubnets, privateSubnets, albSg, servicesSg } = createVpc(name)

// 2. EFS for persistent storage
const storage = createStorage(
  name,
  vpc.id,
  privateSubnets.map((s) => s.id),
  servicesSg.id,
)

// 3. ECS cluster + log group
const { cluster, logGroup } = createCluster(name)

// 4. Cloud Map service discovery
const { services: discoveryServices } = createServiceDiscovery(name, vpc.id)

// 5. ECR repos + build/push images
const { backendRepo, frontendRepo, postgresRepo, keycloakRepo, powersyncRepo } = createEcrAndImages(name)

// 6. ALB with path-based routing
const { alb, frontendTg, backendTg, keycloakTg, powersyncTg } = createAlb({
  name,
  vpcId: vpc.id,
  publicSubnetIds: publicSubnets.map((s) => s.id),
  albSgId: albSg.id,
})

// 7. All Fargate services
createServices({
  name,
  cluster,
  logGroup,
  privateSubnetIds: privateSubnets.map((s) => s.id),
  servicesSgId: servicesSg.id,
  efsId: storage.efs.id,
  pgAccessPointId: storage.pgAccessPoint.id,
  mongoAccessPointId: storage.mongoAccessPoint.id,
  backendImageUri: backendRepo.repositoryUrl.apply((url) => `${url}:latest`),
  frontendImageUri: frontendRepo.repositoryUrl.apply((url) => `${url}:latest`),
  postgresImageUri: postgresRepo.repositoryUrl.apply((url) => `${url}:latest`),
  keycloakImageUri: keycloakRepo.repositoryUrl.apply((url) => `${url}:latest`),
  powersyncImageUri: powersyncRepo.repositoryUrl.apply((url) => `${url}:latest`),
  albDnsName: alb.dnsName,
  targetGroups: {
    frontend: frontendTg,
    backend: backendTg,
    keycloak: keycloakTg,
    powersync: powersyncTg,
  },
  discoveryServices,
})

// Outputs
export const url = pulumi.interpolate`http://${alb.dnsName}`
export const keycloakAdmin = pulumi.interpolate`http://${alb.dnsName}/auth/admin`
export const stackInfo = {
  name: stackName,
  region: pulumi.output(require('@pulumi/aws').getRegionOutput().name),
  destroy: `pulumi destroy -s ${stackName} -y`,
}
