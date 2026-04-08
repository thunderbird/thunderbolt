import * as eks from '@pulumi/eks'
import * as k8s from '@pulumi/kubernetes'
import * as pulumi from '@pulumi/pulumi'

type EksArgs = {
  name: string
  version: string
  vpcId: pulumi.Input<string>
  publicSubnetIds: pulumi.Input<string>[]
  privateSubnetIds: pulumi.Input<string>[]
  ghcrToken?: pulumi.Output<string>
}

export const createEksCluster = (args: EksArgs) => {
  const { name, version, vpcId, publicSubnetIds, privateSubnetIds } = args

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

  // GHCR pull secret for private images
  const chartDeps: pulumi.Resource[] = [ns]

  if (args.ghcrToken) {
    const dockerConfigJson = args.ghcrToken.apply((token) => {
      const auth = Buffer.from(`oauth2:${token}`).toString('base64')
      return JSON.stringify({ auths: { 'ghcr.io': { auth } } })
    })

    const pullSecret = new k8s.core.v1.Secret(
      `${name}-ghcr-pull`,
      {
        metadata: { name: 'ghcr-pull', namespace: 'thunderbolt' },
        type: 'kubernetes.io/dockerconfigjson',
        stringData: { '.dockerconfigjson': dockerConfigJson },
      },
      { provider: k8sProvider, dependsOn: [ns] },
    )

    chartDeps.push(pullSecret)
  }

  // Install the Thunderbolt Helm chart from GHCR
  const imagePrefix = 'ghcr.io/thunderbird/thunderbolt'
  new k8s.helm.v3.Release(
    `${name}-thunderbolt`,
    {
      chart: 'oci://ghcr.io/thunderbird/charts/thunderbolt',
      version,
      namespace: 'thunderbolt',
      values: {
        appUrl: 'http://localhost',
        imagePullSecrets: args.ghcrToken ? [{ name: 'ghcr-pull' }] : [],
        frontend: {
          image: { repository: `${imagePrefix}/thunderbolt-frontend`, tag: version },
        },
        backend: {
          image: { repository: `${imagePrefix}/thunderbolt-backend`, tag: version },
        },
        postgres: {
          image: { repository: `${imagePrefix}/thunderbolt-postgres`, tag: version },
        },
        keycloak: {
          image: { repository: `${imagePrefix}/thunderbolt-keycloak`, tag: version },
        },
        powersync: {
          image: { repository: `${imagePrefix}/thunderbolt-powersync`, tag: version },
        },
      },
    },
    { provider: k8sProvider, dependsOn: chartDeps },
  )

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
