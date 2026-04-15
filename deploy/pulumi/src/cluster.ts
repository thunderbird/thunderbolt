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
