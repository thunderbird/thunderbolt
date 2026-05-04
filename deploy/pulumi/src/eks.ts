/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as aws from '@pulumi/aws'
import * as eks from '@pulumi/eks'
import * as k8s from '@pulumi/kubernetes'
import * as pulumi from '@pulumi/pulumi'

type EksArgs = {
  name: string
  version: string
  imagePrefix: string
  appUrl: string
  vpcId: pulumi.Input<string>
  publicSubnetIds: pulumi.Input<string>[]
  privateSubnetIds: pulumi.Input<string>[]
  ghcrToken?: pulumi.Output<string>
  betterAuthSecretBase64: pulumi.Output<string>
}

export const createEksCluster = (args: EksArgs) => {
  const { name, version, imagePrefix, appUrl, vpcId, publicSubnetIds, privateSubnetIds } = args

  const cluster = new eks.Cluster(`${name}-eks`, {
    vpcId,
    publicSubnetIds,
    privateSubnetIds,
    instanceType: 't3.medium',
    desiredCapacity: 2,
    minSize: 1,
    maxSize: 3,
    createOidcProvider: true,
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

  // EBS CSI driver for PersistentVolume support
  const ebsCsiRole = new aws.iam.Role(`${name}-ebs-csi-role`, {
    assumeRolePolicy: pulumi.all([cluster.oidcProviderArn, cluster.oidcProviderUrl]).apply(([arn, url]) => {
      const issuer = url.replace('https://', '')
      return JSON.stringify({
        Version: '2012-10-17',
        Statement: [{
          Effect: 'Allow',
          Principal: { Federated: arn },
          Action: 'sts:AssumeRoleWithWebIdentity',
          Condition: {
            StringEquals: {
              [`${issuer}:sub`]: 'system:serviceaccount:kube-system:ebs-csi-controller-sa',
              [`${issuer}:aud`]: 'sts.amazonaws.com',
            },
          },
        }],
      })
    }),
  })

  new aws.iam.RolePolicyAttachment(`${name}-ebs-csi-policy`, {
    role: ebsCsiRole.name,
    policyArn: 'arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy',
  })

  const ebsCsiAddon = new aws.eks.Addon(`${name}-ebs-csi`, {
    clusterName: cluster.eksCluster.apply(c => c.name),
    addonName: 'aws-ebs-csi-driver',
    serviceAccountRoleArn: ebsCsiRole.arn,
  })

  const storageClass = new k8s.storage.v1.StorageClass(
    `${name}-gp3`,
    {
      metadata: {
        name: 'gp3',
        annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' },
      },
      provisioner: 'ebs.csi.aws.com',
      parameters: { type: 'gp3' },
      volumeBindingMode: 'WaitForFirstConsumer',
      reclaimPolicy: 'Delete',
    },
    { provider: k8sProvider, dependsOn: [ebsCsiAddon] },
  )

  chartDeps.push(storageClass)

  // Install the Thunderbolt Helm chart from the local chart
  new k8s.helm.v3.Release(
    `${name}-thunderbolt`,
    {
      chart: '../k8s',
      namespace: 'thunderbolt',
      skipAwait: true,
      values: {
        appUrl,
        imagePullSecrets: args.ghcrToken ? [{ name: 'ghcr-pull' }] : [],
        frontend: {
          image: { repository: `${imagePrefix}/thunderbolt-frontend`, tag: version },
        },
        backend: {
          image: { repository: `${imagePrefix}/thunderbolt-backend`, tag: version },
          betterAuthSecretBase64: args.betterAuthSecretBase64,
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
        marketing: {
          image: { repository: `${imagePrefix}/thunderbolt-marketing`, tag: version },
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

  return { cluster, k8sProvider, ingressController }
}
