import * as cloudflare from '@pulumi/cloudflare'
import * as pulumi from '@pulumi/pulumi'

type DnsArgs = {
  name: string
  zoneId: pulumi.Input<string>
  hostname: pulumi.Input<string>
  target: pulumi.Input<string>
  apiToken: pulumi.Input<string>
  proxied?: boolean
}

/**
 * Creates a Cloudflare CNAME record mapping `hostname` to `target`, using a
 * stack-scoped Cloudflare provider authenticated by `apiToken`.
 *
 * Returns the DnsRecord resource plus a derived `url` output (https://hostname).
 *
 * Proxied defaults to true so Cloudflare terminates TLS at the edge and we
 * don't have to wire ACM certificates onto the ALB.
 */
export const createDns = ({ name, zoneId, hostname, target, apiToken, proxied = true }: DnsArgs) => {
  const provider = new cloudflare.Provider(`${name}-cf-provider`, {
    apiToken,
  })

  const record = new cloudflare.DnsRecord(
    `${name}-cname`,
    {
      zoneId,
      name: hostname,
      type: 'CNAME',
      content: target,
      // Cloudflare requires TTL = 1 (auto) when proxied; use 300s when unproxied.
      ttl: proxied ? 1 : 300,
      proxied,
      comment: `Preview environment: ${name}`,
    },
    { provider, deleteBeforeReplace: true },
  )

  const url = pulumi.interpolate`https://${hostname}`

  return { record, url }
}
