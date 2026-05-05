/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as pulumi from '@pulumi/pulumi'
import { createVpc } from './src/vpc'
import { createEksCluster } from './src/eks'
import { createStorage } from './src/storage'
import { createCluster } from './src/cluster'
import { createServiceDiscovery } from './src/discovery'
import { createAlb } from './src/alb'
import { createServices } from './src/services'
import { createDns } from './src/dns'

const config = new pulumi.Config()
const stackName = pulumi.getStack()
const name = `tb-${stackName}`
const platform = config.get('platform') || 'fargate'
const version = config.require('version')

// --- Optional Cloudflare subdomain wiring (used by preview-pr-* stacks) ---
//
// Preview stacks set five per-service hostnames (marketing/app/api/auth/powersync).
// Pulumi creates a proxied CNAME in Cloudflare for each and wires per-service URLs
// into the container env vars. Enterprise stacks leave these unset and fall back
// to the raw ALB hostname + path-based ALB routing.
//
// Back-compat: also accepts legacy `subdomain` (single hostname used for everything)
// and `hostnames` (comma-separated, first is the marketing/primary).
const marketingHostname = config.get('marketingHostname')
const appHostname = config.get('appHostname')
const apiHostname = config.get('apiHostname')
const authHostname = config.get('authHostname')
const powersyncHostname = config.get('powersyncHostname')

const legacyHostnames = (config.get('hostnames') ?? config.get('subdomain') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0)

const hasSubdomainRouting =
  Boolean(marketingHostname || appHostname || apiHostname || authHostname || powersyncHostname) ||
  legacyHostnames.length > 0

const cloudflareZoneId = config.get('cloudflareZoneId')
const cloudflareApiToken = config.getSecret('cloudflareApiToken')

if (hasSubdomainRouting && (!cloudflareZoneId || !cloudflareApiToken)) {
  throw new Error(
    'subdomain routing is configured but cloudflareZoneId and/or cloudflareApiToken are missing — ' +
      'run `pulumi config set cloudflareZoneId <id>` and `pulumi config set --secret cloudflareApiToken <token>`',
  )
}

// Resolve each service's hostname. When a per-service hostname is set, use it.
// Otherwise fall back to the first legacy hostname (single-hostname mode).
const resolvedHostnames = {
  marketing: marketingHostname || legacyHostnames[0],
  app: appHostname || legacyHostnames[0],
  api: apiHostname || legacyHostnames[0],
  auth: authHostname || legacyHostnames[0],
  powersync: powersyncHostname || legacyHostnames[0],
} as const

// Dedupe for DNS creation (legacy mode may reuse the same hostname for multiple services)
const uniqueHostnamesForDns = hasSubdomainRouting
  ? Array.from(new Set(Object.values(resolvedHostnames).filter((h): h is string => Boolean(h))))
  : []

// All images are pre-built and published to GHCR by the images-publish workflow
const imagePrefix = 'ghcr.io/thunderbird/thunderbolt'
const images = {
  frontend: `${imagePrefix}/thunderbolt-frontend:${version}`,
  backend: `${imagePrefix}/thunderbolt-backend:${version}`,
  postgres: `${imagePrefix}/thunderbolt-postgres:${version}`,
  keycloak: `${imagePrefix}/thunderbolt-keycloak:${version}`,
  powersync: `${imagePrefix}/thunderbolt-powersync:${version}`,
  marketing: `${imagePrefix}/thunderbolt-marketing:${version}`,
}

// Secrets — override per-stack via `pulumi config set --secret <key> <value>`
const secrets = {
  postgresPassword: config.getSecret('postgresPassword') ?? pulumi.output('postgres'),
  keycloakAdminPassword: config.getSecret('keycloakAdminPassword') ?? pulumi.output('admin'),
  oidcClientSecret: config.getSecret('oidcClientSecret') ?? pulumi.output('thunderbolt-enterprise-secret'),
  powersyncJwtSecret: config.getSecret('powersyncJwtSecret') ?? pulumi.output('enterprise-thunderbolt-powersync-jwt-default-secret'),
  betterAuthSecret: config.getSecret('betterAuthSecret') ?? pulumi.output('enterprise-thunderbolt-better-auth-default-secret'),
  powersyncDbPassword: config.getSecret('powersyncDbPassword') ?? pulumi.output('myhighlyrandompassword'),
  // AI provider keys — empty default so enterprise stacks don't need them set.
  anthropicApiKey: config.getSecret('anthropicApiKey') ?? pulumi.output(''),
  fireworksApiKey: config.getSecret('fireworksApiKey') ?? pulumi.output(''),
  mistralApiKey: config.getSecret('mistralApiKey') ?? pulumi.output(''),
  thunderboltInferenceApiKey: config.getSecret('thunderboltInferenceApiKey') ?? pulumi.output(''),
  exaApiKey: config.getSecret('exaApiKey') ?? pulumi.output(''),
}

// Thunderbolt inference gateway URL (not a secret; set per-stack)
const thunderboltInferenceUrl = config.get('thunderboltInferenceUrl') ?? ''

// --- Insecure-default credentials warning ---------------------------------
//
// Detect any credentials still set to their public, well-known sentinel
// values and emit a *very* loud warning at deploy time. Resources are still
// created — the goal is awareness, not blocking — but the warning prints in
// yellow during `pulumi preview` and `pulumi up`, and surfaces as a stack
// output (`securityWarnings`) for post-deploy auditing / CI assertions.
//
// Suppress (e.g. for short-lived eval stacks) with:
//   pulumi config set dangerouslyAllowDefaultCreds true
//
// Inline list rather than imported from shared/insecure-defaults.ts because
// pulling files from outside this directory pushes TypeScript's common
// source root above the project (TS5011) when ts-node compiles index.ts
// during `pulumi up`. Keep this in sync with shared/insecure-defaults.ts —
// the shared module is the canonical source for backend + frontend, this
// is the deploy-time mirror.
const INSECURE_DEFAULTS_DOCS_URL =
  'https://github.com/thunderbird/thunderbolt/blob/main/deploy/README.md#default-credentials'
const INSECURE_DEFAULTS = [
  { pulumiKey: 'postgresPassword', description: 'PostgreSQL admin password' },
  { pulumiKey: 'keycloakAdminPassword', description: 'Keycloak admin console password' },
  { pulumiKey: 'oidcClientSecret', description: 'OIDC client secret' },
  { pulumiKey: 'powersyncJwtSecret', description: 'PowerSync JWT signing secret' },
  { pulumiKey: 'betterAuthSecret', description: 'Better Auth session signing secret' },
  { pulumiKey: 'powersyncDbPassword', description: 'PowerSync database role password' },
] as const

const dangerouslyAllowDefaultCreds = (config.get('dangerouslyAllowDefaultCreds') ?? '').toLowerCase() === 'true'
const dangerouslyAllowDefaultCredsViaEnv = process.env.DANGEROUSLY_ALLOW_DEFAULT_CREDS?.toLowerCase() === 'true'
const insecureDefaultsHushed = dangerouslyAllowDefaultCreds || dangerouslyAllowDefaultCredsViaEnv

const insecureDefaultMatches = insecureDefaultsHushed
  ? []
  : INSECURE_DEFAULTS.filter((entry) => {
      const configured = config.getSecret(entry.pulumiKey)
      // No config value → fallback in `secrets` above is the sentinel → match.
      // A config value exists but equals the sentinel → also a match.
      // We can't synchronously read a Pulumi.Output here, so fall back to the
      // simpler check: if `config.getSecret` returned undefined, the fallback
      // (the sentinel) is in use.
      return configured === undefined
    })

if (insecureDefaultMatches.length > 0) {
  pulumi.log.warn(
    `\n` +
      `╔════════════════════════════════════════════════════════════════════════════╗\n` +
      `║  🚨🚨🚨   INSECURE DEFAULT CREDENTIALS IN USE   🚨🚨🚨                      ║\n` +
      `╠════════════════════════════════════════════════════════════════════════════╣\n` +
      `║                                                                            ║\n` +
      `║  This stack has not overridden the following secrets, so the public        ║\n` +
      `║  default values from deploy/ will be deployed into your AWS account:       ║\n` +
      `║                                                                            ║\n` +
      insecureDefaultMatches
        .map((m) => {
          const line = `║    • ${m.pulumiKey}  —  ${m.description}`
          return line + ' '.repeat(Math.max(0, 78 - line.length)) + '║'
        })
        .join('\n') +
      `\n║                                                                            ║\n` +
      `║  These values are PUBLIC. Anyone who finds this deploy can read them.      ║\n` +
      `║                                                                            ║\n` +
      `║  Override each with:                                                       ║\n` +
      `║    pulumi config set --secret <key> <value> -s ${stackName}` +
      ' '.repeat(Math.max(0, 78 - (`    pulumi config set --secret <key> <value> -s ${stackName}`.length + 4))) +
      `    ║\n` +
      `║                                                                            ║\n` +
      `║  Docs:                                                                     ║\n` +
      `║    ${INSECURE_DEFAULTS_DOCS_URL}` +
      ' '.repeat(Math.max(0, 78 - (`    ${INSECURE_DEFAULTS_DOCS_URL}`.length + 4))) +
      `    ║\n` +
      `║                                                                            ║\n` +
      `║  Suppress this warning (DO NOT do this in production):                     ║\n` +
      `║    pulumi config set dangerouslyAllowDefaultCreds true                     ║\n` +
      `║                                                                            ║\n` +
      `╚════════════════════════════════════════════════════════════════════════════╝\n`,
  )
  for (const m of insecureDefaultMatches) {
    pulumi.log.warn(`Insecure default in use: ${m.pulumiKey} (${m.description})`)
  }
}

// Surface as stack output for post-deploy audit / CI assertion.
export const securityWarnings = insecureDefaultMatches.map((m) => m.pulumiKey)

// Shared: VPC (both platforms need this)
const { vpc, publicSubnets, privateSubnets, albSg, servicesSg } = createVpc(name)

if (platform === 'k8s') {
  // ---------- Kubernetes (EKS) ----------
  const appUrl = config.get('appUrl') || 'http://localhost'
  const { cluster } = createEksCluster({
    name,
    version,
    imagePrefix,
    appUrl,
    vpcId: vpc.id,
    publicSubnetIds: publicSubnets.map((s) => s.id),
    privateSubnetIds: privateSubnets.map((s) => s.id),
    ghcrToken: config.getSecret('ghcrToken'),
    betterAuthSecretBase64: secrets.betterAuthSecret.apply((s) => Buffer.from(s).toString('base64')),
  })

  module.exports = {
    platform: 'k8s',
    kubeconfig: cluster.kubeconfigJson,
    note: 'Run: kubectl get svc -n ingress-nginx ingress-nginx-controller -o jsonpath="{.status.loadBalancer.ingress[0].hostname}" to get the URL',
    stackInfo: {
      name: stackName,
      destroy: `pulumi destroy -s ${stackName} -y`,
    },
  }
} else {
  // ---------- Fargate (ECS) ----------
  const storage = createStorage(
    name,
    vpc.id,
    privateSubnets.map((s) => s.id),
    servicesSg.id,
  )

  const { cluster, logGroup } = createCluster(name)
  const { services: discoveryServices } = createServiceDiscovery(name, vpc.id)

  const { alb, listener, frontendTg, backendTg, keycloakTg, powersyncTg, marketingTg } = createAlb({
    name,
    vpcId: vpc.id,
    publicSubnetIds: publicSubnets.map((s) => s.id),
    albSgId: albSg.id,
    hostnames: hasSubdomainRouting ? resolvedHostnames : undefined,
  })

  // Create Cloudflare CNAMEs for each unique hostname, all pointing at the ALB.
  if (hasSubdomainRouting) {
    createDns({
      name,
      zoneId: cloudflareZoneId!,
      hostnames: uniqueHostnamesForDns,
      target: alb.dnsName,
      apiToken: cloudflareApiToken!,
    })
  }

  // Per-service public URLs for env var wiring. If subdomain routing is active,
  // each service uses its own subdomain URL. Otherwise all services share the
  // raw ALB URL and routing falls back to path-based (enterprise stacks).
  const albFallback = pulumi.interpolate`http://${alb.dnsName}`
  const publicUrls = {
    marketing: resolvedHostnames.marketing ? (pulumi.interpolate`https://${resolvedHostnames.marketing}` as pulumi.Input<string>) : albFallback,
    app: resolvedHostnames.app ? (pulumi.interpolate`https://${resolvedHostnames.app}` as pulumi.Input<string>) : albFallback,
    api: resolvedHostnames.api ? (pulumi.interpolate`https://${resolvedHostnames.api}` as pulumi.Input<string>) : albFallback,
    auth: resolvedHostnames.auth ? (pulumi.interpolate`https://${resolvedHostnames.auth}` as pulumi.Input<string>) : albFallback,
    powersync: resolvedHostnames.powersync ? (pulumi.interpolate`https://${resolvedHostnames.powersync}` as pulumi.Input<string>) : albFallback,
  }

  createServices({
    name,
    cluster,
    logGroup,
    privateSubnetIds: privateSubnets.map((s) => s.id),
    servicesSgId: servicesSg.id,
    efsId: storage.efs.id,
    pgAccessPointId: storage.pgAccessPoint.id,
    images,
    secrets,
    ghcrToken: config.getSecret('ghcrToken'),
    publicUrls,
    thunderboltInferenceUrl,
    behindCloudflareProxy: hasSubdomainRouting,
    albListener: listener,
    targetGroups: {
      frontend: frontendTg,
      backend: backendTg,
      keycloak: keycloakTg,
      powersync: powersyncTg,
      marketing: marketingTg,
    },
    discoveryServices,
  })

  module.exports = {
    platform: 'fargate',
    // Primary user-facing URL is the marketing/app entry (preview: marketing; enterprise: ALB path-based)
    url: publicUrls.marketing,
    urls: publicUrls,
    albDnsName: alb.dnsName,
    stackInfo: {
      name: stackName,
      destroy: `pulumi destroy -s ${stackName} -y`,
    },
  }
}
