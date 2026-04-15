import * as aws from '@pulumi/aws'
import * as eks from '@pulumi/eks'
import * as k8s from '@pulumi/kubernetes'
import * as pulumi from '@pulumi/pulumi'
import * as path from 'path'
import * as fs from 'fs'

type EksArgs = {
  name: string
  vpcId: pulumi.Input<string>
  publicSubnetIds: pulumi.Input<string>[]
  privateSubnetIds: pulumi.Input<string>[]
  backendImageUri: pulumi.Input<string>
  frontendImageUri: pulumi.Input<string>
}

export const createEksCluster = (args: EksArgs) => {
  const { name, vpcId, publicSubnetIds, privateSubnetIds } = args

  const cluster = new eks.Cluster(`${name}-eks`, {
    vpcId,
    publicSubnetIds,
    privateSubnetIds,
    instanceType: 't3.medium',
    desiredCapacity: 2,
    minSize: 1,
    maxSize: 3,
    tags: { Name: `${name}-eks` },
  })

  const k8sProvider = new k8s.Provider(`${name}-k8s`, {
    kubeconfig: cluster.kubeconfigJson,
  })

  const ns = new k8s.core.v1.Namespace(
    `${name}-ns`,
    { metadata: { name: 'thunderbolt' } },
    { provider: k8sProvider },
  )

  // Read manifest files from k8s directory
  const k8sDir = path.resolve(__dirname, '../../k8s')
  const manifestFiles = [
    'secrets.yaml.example', // use example as default
    'postgres.yaml',
    'mongo.yaml',
    'powersync.yaml',
    'keycloak.yaml',
    'backend.yaml',
    'frontend.yaml',
    'ingress.yaml',
  ]

  // Create ConfigMaps from config files
  const configDir = path.resolve(__dirname, '../../config')
  const dockerDir = path.resolve(__dirname, '../../docker')

  const nginxConfig = new k8s.core.v1.ConfigMap(
    `${name}-nginx-config`,
    {
      metadata: { name: 'nginx-config', namespace: 'thunderbolt' },
      data: { 'default.conf': fs.readFileSync(path.join(configDir, 'nginx.conf'), 'utf-8') },
    },
    { provider: k8sProvider, dependsOn: [ns] },
  )

  const postgresInit = new k8s.core.v1.ConfigMap(
    `${name}-postgres-init`,
    {
      metadata: { name: 'postgres-init', namespace: 'thunderbolt' },
      data: {
        '01-powersync.sql': fs.readFileSync(path.join(dockerDir, 'postgres-init', '01-powersync.sql'), 'utf-8'),
      },
    },
    { provider: k8sProvider, dependsOn: [ns] },
  )

  const powersyncConfig = new k8s.core.v1.ConfigMap(
    `${name}-powersync-config`,
    {
      metadata: { name: 'powersync-config', namespace: 'thunderbolt' },
      data: { 'config.yaml': fs.readFileSync(path.join(configDir, 'powersync-config.yaml'), 'utf-8') },
    },
    { provider: k8sProvider, dependsOn: [ns] },
  )

  const keycloakRealm = new k8s.core.v1.ConfigMap(
    `${name}-keycloak-realm`,
    {
      metadata: { name: 'keycloak-realm', namespace: 'thunderbolt' },
      data: {
        'thunderbolt-realm.json': fs.readFileSync(path.join(configDir, 'keycloak-realm.json'), 'utf-8'),
      },
    },
    { provider: k8sProvider, dependsOn: [ns] },
  )

  // Apply each manifest
  const configMaps = [nginxConfig, postgresInit, powersyncConfig, keycloakRealm]

  const resources = manifestFiles.map((file) => {
    const filePath = path.join(k8sDir, file)
    if (!fs.existsSync(filePath)) return null

    return new k8s.yaml.ConfigFile(
      `${name}-${file.replace('.yaml', '').replace('.example', '')}`,
      { file: filePath },
      { provider: k8sProvider, dependsOn: [ns, ...configMaps] },
    )
  })

  // Install nginx-ingress controller
  const ingressController = new k8s.helm.v3.Release(
    `${name}-ingress-nginx`,
    {
      chart: 'ingress-nginx',
      repositoryOpts: { repo: 'https://kubernetes.github.io/ingress-nginx' },
      namespace: 'ingress-nginx',
      createNamespace: true,
      values: {
        controller: {
          service: { type: 'LoadBalancer' },
        },
      },
    },
    { provider: k8sProvider },
  )

  // Get the ingress controller's load balancer hostname
  const ingressService = k8s.core.v1.Service.get(
    `${name}-ingress-svc`,
    pulumi.interpolate`ingress-nginx/ingress-nginx-controller`,
    { provider: k8sProvider, dependsOn: [ingressController] },
  )

  const lbHostname = ingressService.status.loadBalancer.ingress[0].hostname

  return { cluster, k8sProvider, lbHostname }
}
