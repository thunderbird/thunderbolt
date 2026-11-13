/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Cloudflare DNS is the public route for these Fargate stacks. */
export const cloudflareProxiedStack = (platform: string, hasSubdomainRouting: boolean) =>
  platform === 'fargate' && hasSubdomainRouting

/** Validate every service has a Cloudflare route before restricting ALB ingress. */
export const requireCompleteServiceHostnames = (
  platform: string,
  hasSubdomainRouting: boolean,
  hostnames: Record<string, string | undefined>,
) => {
  if (!cloudflareProxiedStack(platform, hasSubdomainRouting)) return
  const missing = Object.entries(hostnames)
    .filter(([, hostname]) => !hostname)
    .map(([service]) => service)
  if (missing.length > 0) {
    throw new Error(`Cloudflare Fargate routing requires hostnames for: ${missing.join(', ')}`)
  }
}

/** Shared preview ALB ingress and per-PR backend trust must use the same edge. */
export const previewCloudflareProxy = { restrictIngress: true, trustedProxy: 'cloudflare' } as const

/** Whether five distinct hostnames allow strict host-only ALB routing. */
export const cloudflareOnlyStack = (platform: string, hostnames: (string | undefined)[]) =>
  platform === 'fargate' && hostnames.length === 5 && hostnames.every(Boolean) && new Set(hostnames).size === 5

/** Shared previews require Cloudflare DNS because their ALB accepts only Cloudflare traffic. */
export const requirePreviewCloudflareConfig = (zoneId: string | undefined, apiToken: unknown) => {
  if (!zoneId || !apiToken) {
    throw new Error('previews-shared requires cloudflareZoneId and cloudflareApiToken')
  }
}

/** Restrict HTTP ingress to Cloudflare when the backend trusts CF-Connecting-IP. */
export const albIngress = (behindCloudflare: boolean, cloudflareIpv4Cidrs: string[]) => {
  if (behindCloudflare && cloudflareIpv4Cidrs.length === 0) {
    throw new Error('Cloudflare IPv4 ranges are empty')
  }
  return behindCloudflare
    ? [{ protocol: 'tcp', fromPort: 80, toPort: 80, cidrBlocks: cloudflareIpv4Cidrs }]
    : [
        { protocol: 'tcp', fromPort: 80, toPort: 80, cidrBlocks: ['0.0.0.0/0'] },
        { protocol: 'tcp', fromPort: 443, toPort: 443, cidrBlocks: ['0.0.0.0/0'] },
      ]
}
