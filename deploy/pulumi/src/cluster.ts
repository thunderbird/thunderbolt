/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as aws from '@pulumi/aws'

export const createCluster = (name: string) => {
  const cluster = new aws.ecs.Cluster(`${name}-cluster`, {
    settings: [{ name: 'containerInsights', value: 'enabled' }],
    tags: { Name: `${name}-cluster` },
  })

  const logGroup = new aws.cloudwatch.LogGroup(`${name}-logs`, {
    retentionInDays: 7,
    tags: { Name: `${name}-logs` },
  })

  return { cluster, logGroup }
}
