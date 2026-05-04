/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as aws from '@pulumi/aws'
import * as pulumi from '@pulumi/pulumi'

export const createServiceDiscovery = (name: string, vpcId: pulumi.Input<string>) => {
  const namespace = new aws.servicediscovery.PrivateDnsNamespace(`${name}-ns`, {
    name: 'thunderbolt.local',
    vpc: vpcId,
    tags: { Name: `${name}-ns` },
  })

  const serviceNames = ['postgres', 'powersync', 'keycloak', 'backend', 'frontend', 'marketing'] as const

  const services = Object.fromEntries(
    serviceNames.map((svc) => [
      svc,
      new aws.servicediscovery.Service(`${name}-${svc}-discovery`, {
        name: svc,
        namespaceId: namespace.id,
        dnsConfig: {
          namespaceId: namespace.id,
          dnsRecords: [{ ttl: 10, type: 'A' }],
          routingPolicy: 'MULTIVALUE',
        },
        healthCheckCustomConfig: { failureThreshold: 1 },
        tags: { Name: `${name}-${svc}` },
      }),
    ]),
  ) as Record<(typeof serviceNames)[number], aws.servicediscovery.Service>

  return { namespace, services }
}
