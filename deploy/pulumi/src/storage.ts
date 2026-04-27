/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as aws from '@pulumi/aws'
import * as pulumi from '@pulumi/pulumi'

export const createStorage = (name: string, vpcId: pulumi.Input<string>, subnetIds: pulumi.Input<string>[], servicesSgId: pulumi.Input<string>) => {
  const efs = new aws.efs.FileSystem(`${name}-efs`, {
    encrypted: true,
    tags: { Name: `${name}-efs` },
  })

  const efsSg = new aws.ec2.SecurityGroup(`${name}-efs-sg`, {
    vpcId,
    ingress: [{ protocol: 'tcp', fromPort: 2049, toPort: 2049, securityGroups: [servicesSgId] }],
    egress: [{ protocol: '-1', fromPort: 0, toPort: 0, cidrBlocks: ['0.0.0.0/0'] }],
    tags: { Name: `${name}-efs-sg` },
  })

  const mountTargets = subnetIds.map(
    (subnetId, i) =>
      new aws.efs.MountTarget(`${name}-efs-mt-${i}`, {
        fileSystemId: efs.id,
        subnetId,
        securityGroups: [efsSg.id],
      }),
  )

  const pgAccessPoint = new aws.efs.AccessPoint(`${name}-pg-ap`, {
    fileSystemId: efs.id,
    posixUser: { uid: 999, gid: 999 }, // postgres user
    rootDirectory: {
      path: '/postgres-data',
      creationInfo: { ownerUid: 999, ownerGid: 999, permissions: '700' },
    },
    tags: { Name: `${name}-pg` },
  })

  const mongoAccessPoint = new aws.efs.AccessPoint(`${name}-mongo-ap`, {
    fileSystemId: efs.id,
    posixUser: { uid: 999, gid: 999 },
    rootDirectory: {
      path: '/mongo-data',
      creationInfo: { ownerUid: 999, ownerGid: 999, permissions: '700' },
    },
    tags: { Name: `${name}-mongo` },
  })

  return { efs, mountTargets, pgAccessPoint, mongoAccessPoint }
}
