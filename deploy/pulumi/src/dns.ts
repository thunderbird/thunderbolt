/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as cloudflare from '@pulumi/cloudflare'
import * as pulumi from '@pulumi/pulumi'

type DnsArgs = {
  name: string
  zoneId: pulumi.Input<string>
  /**
   * One or more hostnames to point at `target`. The first entry is treated as the
   * primary and becomes the exported `url` (used by the backend for OIDC redirects,
   * CORS, etc.). Additional entries create extra CNAMEs pointing at the same target —
   * useful for multi-subdomain previews (e.g. `app-pr-N`, `api-pr-N`, `pr-N`).
   */
  hostnames: string[]
  target: pulumi.Input<string>
  apiToken: pulumi.Input<string>
  proxied?: boolean
}

/**
 * Creates Cloudflare CNAME records mapping each `hostname` to `target`, using a
 * stack-scoped Cloudflare provider authenticated by `apiToken`.
 *
 * Returns the DnsRecord resources plus a derived `url` output (https://<first-hostname>).
 *
 * Proxied defaults to true so Cloudflare terminates TLS at the edge and we
 * don't have to wire ACM certificates onto the ALB.
 */
export const createDns = ({ name, zoneId, hostnames, target, apiToken, proxied = true }: DnsArgs) => {
  if (hostnames.length === 0) {
    throw new Error('createDns requires at least one hostname')
  }

  const provider = new cloudflare.Provider(`${name}-cf-provider`, {
    apiToken,
  })

  const records = hostnames.map(
    (hostname, i) =>
      new cloudflare.DnsRecord(
        `${name}-cname-${i}`,
        {
          zoneId,
          name: hostname,
          type: 'CNAME',
          content: target,
          // Cloudflare requires TTL = 1 (auto) when proxied; use 300s when unproxied.
          ttl: proxied ? 1 : 300,
          proxied,
          comment: `Preview environment: ${name} (${hostname})`,
        },
        { provider, deleteBeforeReplace: true },
      ),
  )

  const url = pulumi.interpolate`https://${hostnames[0]}`

  return { records, url }
}
