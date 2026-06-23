/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from 'zod'

/**
 * Settings schema for environment variables validation
 */
const settingsSchema = z
  .object({
    // API Keys
    fireworksApiKey: z.string().default(''),
    mistralApiKey: z.string().default(''),
    anthropicApiKey: z.string().default(''),
    exaApiKey: z.string().default(''),
    tinfoilApiKey: z.string().default(''),
    // Include the `/v1` API prefix — Tinfoil's OpenAI-compatible endpoints live
    // under `/v1/chat/completions`, `/v1/models`, etc.
    tinfoilEnclaveUrl: z.string().default('https://inference.tinfoil.sh/v1'),

    // Health Check Configuration
    monitoringToken: z.string().default(''),

    // OAuth Settings
    googleClientId: z.string().trim().default(''),
    googleClientSecret: z.string().trim().default(''),
    microsoftClientId: z.string().trim().default(''),
    microsoftClientSecret: z.string().trim().default(''),

    // OIDC Settings (enterprise self-hosted)
    authMode: z.enum(['consumer', 'oidc', 'saml']).default('consumer'),
    // Anonymous-session overlay — opt-in. When false, the anonymous() Better Auth plugin
    // is NOT registered so /v1/api/auth/sign-in/anonymous returns 404. Defense-in-depth
    // against a malicious client bypassing the frontend gate via direct curl.
    authAllowAnonymous: z.boolean().default(false),
    oidcClientId: z.string().default(''),
    oidcClientSecret: z.string().default(''),
    oidcIssuer: z.string().default(''),
    // Optional override for the OIDC discovery endpoint URL. Defaults to
    // `${oidcIssuer}/.well-known/openid-configuration` when unset, which is correct for
    // any deployment where the backend reaches the IdP at the same hostname embedded in
    // tokens. Containerized self-hosted setups can split the two: backend hits
    // discovery at an internal hostname (e.g. `http://keycloak:8080/...`) while
    // tokens are issued with a browser-facing hostname (e.g. `http://localhost:8180/...`).
    oidcDiscoveryUrl: z.string().default(''),
    samlEntryPoint: z.string().default(''),
    samlEntityId: z.string().default(''),
    samlIdpIssuer: z.string().default(''),
    samlCert: z.string().default(''),
    betterAuthUrl: z.string().default('http://localhost:8000'),
    betterAuthSecret: z.string().min(1),

    // General settings
    logLevel: z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR']).default('INFO'),
    port: z.coerce.number().default(8000),
    appUrl: z
      .string()
      .default('http://localhost:1420')
      .transform((s) => s.replace(/\/$/, '')),

    // Analytics settings
    posthogHost: z.string().default('https://us.i.posthog.com'),
    posthogApiKey: z.string().default(''),

    // Waitlist settings
    waitlistEnabled: z.boolean().default(false),
    waitlistAutoApproveDomains: z.string().default(''),

    // PowerSync settings
    powersyncUrl: z.string().default(''),
    powersyncJwtKid: z.string().default(''),
    powersyncJwtSecret: z.string().default(''),
    powersyncTokenExpirySeconds: z.coerce.number().int().positive().default(3600),

    // CORS settings — comma-separated list of exact origins.
    // `corsAllowHeaders` is no longer consumed by any production mount: both
    // the main backend and the PostHog proxy use `cors({ allowedHeaders: true })`,
    // which echoes the request's Access-Control-Request-Headers. The env var
    // and default remain only for backward compat and test fixtures.
    corsOrigins: z.string().default('http://localhost:1420,tauri://localhost,http://tauri.localhost'),
    corsAllowCredentials: z.boolean().default(true),
    corsAllowMethods: z.string().default('GET,POST,PUT,DELETE,PATCH,OPTIONS'),
    corsAllowHeaders: z.string().default(''),
    // Protocol-required: frontend proxy-fetch.ts unwrap needs these visible cross-origin (cors does not echo expose-headers).
    corsExposeHeaders: z
      .string()
      .default(
        'set-auth-token,X-Proxy-Final-Url,X-Proxy-Passthrough-Content-Type,X-Proxy-Passthrough-Mcp-Session-Id,X-Proxy-Passthrough-Mcp-Protocol-Version,X-Proxy-Passthrough-Location,X-Proxy-Passthrough-Anthropic-Version,WWW-Authenticate',
      ),

    // E2E encryption — when true, devices must complete the trust flow before syncing
    e2eeEnabled: z.boolean().default(false),

    swaggerEnabled: z.boolean().default(false),

    // Rate limiting
    rateLimitEnabled: z.boolean().default(true),

    // Trusted proxy (controls which proxy headers are trusted for IP extraction)
    // Set to 'cloudflare' to trust CF-Connecting-IP, 'akamai' for True-Client-IP,
    // or leave empty to use only the direct socket IP (proxy headers are NOT trusted)
    trustedProxy: z.enum(['', 'cloudflare', 'akamai']).default(''),

    // ACP (Agent Client Protocol) settings
    // Comma-separated list of agent IDs to expose via GET /agents. Empty = all registered.
    enabledAgents: z.string().default(''),
    // When false, the discovery response sets allowCustomAgents: false and the UI hides "+ Add Custom Agent".
    allowCustomAgents: z.boolean().default(true),
    // When true, the built-in Thunderbolt agent is omitted entirely from the client's agent
    // list (not just disabled) — for deployments that ship only their own agents (e.g. Deepset).
    // Surfaced to the UI via GET /config as `builtInAgentEnabled`.
    disableBuiltInAgent: z.boolean().default(false),
    // Haystack-specific config (consumed by the Haystack provider, defined here for centralized config).
    haystackBaseUrl: z.string().default(''),
    haystackApiKey: z.string().default(''),
    // Deepset workspace slug. URLs are `${baseUrl}/api/v1/workspaces/${workspace}/...`.
    haystackWorkspace: z.string().default(''),
    // JSON array of pipeline descriptors: [{id, name, pipelineName, pipelineId, description?, icon?}].
    // `id` is the public slug; `pipelineName` is the Deepset URL slug; `pipelineId` is the Deepset UUID.
    haystackPipelines: z.string().default(''),
  })
  .superRefine((data, ctx) => {
    if (data.powersyncUrl && data.powersyncJwtSecret.length < 32) {
      ctx.addIssue({
        code: 'too_small',
        origin: 'string',
        minimum: 32,
        inclusive: true,
        message: 'powersyncJwtSecret must be at least 32 characters when powersyncUrl is set',
        path: ['powersyncJwtSecret'],
        input: '[REDACTED]',
      })
    }
  })

export type Settings = z.infer<typeof settingsSchema>

/**
 * Parse and validate environment variables into settings
 */
const parseSettings = (): Settings => {
  const isDevelopment = process.env.NODE_ENV === 'development'
  const env = {
    fireworksApiKey: process.env.FIREWORKS_API_KEY || '',
    mistralApiKey: process.env.MISTRAL_API_KEY || '',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    exaApiKey: process.env.EXA_API_KEY || '',
    tinfoilApiKey: process.env.TINFOIL_API_KEY || '',
    tinfoilEnclaveUrl: process.env.TINFOIL_ENCLAVE_URL || 'https://inference.tinfoil.sh/v1',
    monitoringToken: process.env.MONITORING_TOKEN || '',
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    microsoftClientId: process.env.MICROSOFT_CLIENT_ID || '',
    microsoftClientSecret: process.env.MICROSOFT_CLIENT_SECRET || '',
    authMode: (process.env.AUTH_MODE || 'consumer').toLowerCase(),
    authAllowAnonymous: process.env.AUTH_ALLOW_ANONYMOUS === 'true',
    oidcClientId: process.env.OIDC_CLIENT_ID || '',
    oidcClientSecret: process.env.OIDC_CLIENT_SECRET || '',
    oidcIssuer: process.env.OIDC_ISSUER || '',
    oidcDiscoveryUrl: process.env.OIDC_DISCOVERY_URL || '',
    samlEntryPoint: process.env.SAML_ENTRY_POINT || '',
    samlEntityId: process.env.SAML_ENTITY_ID || '',
    samlIdpIssuer: process.env.SAML_IDP_ISSUER || '',
    samlCert: process.env.SAML_CERT || '',
    betterAuthUrl: process.env.BETTER_AUTH_URL || 'http://localhost:8000',
    betterAuthSecret: process.env.BETTER_AUTH_SECRET,
    logLevel: (process.env.LOG_LEVEL || 'INFO').toUpperCase(),
    port: process.env.PORT || '8000',
    appUrl: process.env.APP_URL || 'http://localhost:1420',
    posthogHost: process.env.POSTHOG_HOST || 'https://us.i.posthog.com',
    posthogApiKey: process.env.POSTHOG_API_KEY || '',
    waitlistEnabled: process.env.WAITLIST_ENABLED === 'true',
    waitlistAutoApproveDomains: process.env.WAITLIST_AUTO_APPROVE_DOMAINS || '',
    // Localhost defaults apply only in development. In any other NODE_ENV the
    // value defaults to '' so the schema's superRefine guard correctly rejects
    // an empty JWT secret whenever POWERSYNC_URL is set explicitly.
    powersyncUrl: process.env.POWERSYNC_URL || (isDevelopment ? 'http://localhost:8080' : ''),
    powersyncJwtKid: process.env.POWERSYNC_JWT_KID || (isDevelopment ? 'powersync-dev' : ''),
    powersyncJwtSecret:
      process.env.POWERSYNC_JWT_SECRET || (isDevelopment ? 'powersync-dev-secret-change-in-production' : ''),
    powersyncTokenExpirySeconds: process.env.POWERSYNC_TOKEN_EXPIRY_SECONDS || '3600',
    corsOrigins: process.env.CORS_ORIGINS || 'http://localhost:1420,tauri://localhost,http://tauri.localhost',
    corsAllowCredentials: process.env.CORS_ALLOW_CREDENTIALS !== 'false',
    corsAllowMethods: process.env.CORS_ALLOW_METHODS || 'GET,POST,PUT,DELETE,PATCH,OPTIONS',
    corsAllowHeaders: process.env.CORS_ALLOW_HEADERS || '',
    corsExposeHeaders:
      process.env.CORS_EXPOSE_HEADERS ||
      'set-auth-token,X-Proxy-Final-Url,X-Proxy-Passthrough-Content-Type,X-Proxy-Passthrough-Mcp-Session-Id,X-Proxy-Passthrough-Mcp-Protocol-Version,X-Proxy-Passthrough-Location,X-Proxy-Passthrough-Anthropic-Version,WWW-Authenticate',
    e2eeEnabled: process.env.E2EE_ENABLED === 'true',
    swaggerEnabled: process.env.SWAGGER_ENABLED === 'true',
    rateLimitEnabled: process.env.RATE_LIMIT_ENABLED !== 'false',
    trustedProxy: (process.env.TRUSTED_PROXY || '').toLowerCase(),
    enabledAgents: process.env.ENABLED_AGENTS || '',
    allowCustomAgents: process.env.ALLOW_CUSTOM_AGENTS !== 'false',
    disableBuiltInAgent: process.env.DISABLE_BUILT_IN_AGENT === 'true',
    haystackBaseUrl: process.env.HAYSTACK_BASE_URL || '',
    haystackApiKey: process.env.HAYSTACK_API_KEY || '',
    haystackWorkspace: process.env.HAYSTACK_WORKSPACE || '',
    haystackPipelines: process.env.HAYSTACK_PIPELINES || '',
  }

  return settingsSchema.parse(env)
}

// Global settings instance
let settings: Settings | null = null

/**
 * Get the current settings instance (cached)
 */
export const getSettings = (): Settings => {
  if (!settings) {
    settings = parseSettings()
  }
  return settings
}

/**
 * Clear the cached settings (for testing)
 */
export const clearSettingsCache = (): void => {
  settings = null
}

/** Parse comma-separated CORS origins into a list. */
export const getCorsOriginsList = (settings: Pick<Settings, 'corsOrigins'>): string[] => {
  return settings.corsOrigins
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0)
}

/** Check whether a given origin is allowed by the configured CORS origins (exact match). */
export const isOriginAllowed = (origin: string, settings: Pick<Settings, 'corsOrigins'>): boolean => {
  return getCorsOriginsList(settings).includes(origin)
}

/** Validate that an OAuth redirect_uri points to a trusted origin. */
export const isOAuthRedirectUriAllowed = (uri: string, settings: Pick<Settings, 'corsOrigins'>): boolean => {
  try {
    const url = new URL(uri)
    // Construct origin manually — url.origin returns 'null' for non-standard protocols like tauri://
    const origin = `${url.protocol}//${url.host}`
    const allowedOrigins = [...getCorsOriginsList(settings), 'https://app.thunderbolt.io']
    if (allowedOrigins.includes(origin)) {
      return true
    }
    // Loopback flow uses dynamic ports — allow any HTTP localhost
    if ((url.hostname === 'localhost' || url.hostname === '127.0.0.1') && url.protocol === 'http:') {
      return true
    }
    return false
  } catch {
    return false
  }
}

export const getCorsMethodsList = (settings: Settings): string[] => {
  return settings.corsAllowMethods
    .split(',')
    .map((method) => method.trim())
    .filter((method) => method.length > 0)
}

/**
 * Parse comma-separated ENABLED_AGENTS into a list. Empty string yields an empty
 * array — callers MUST interpret that as "no filter, expose all registered providers".
 */
export const getEnabledAgentsList = (settings: Pick<Settings, 'enabledAgents'>): string[] => {
  return settings.enabledAgents
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
}

/** Parse comma-separated auto-approved domains into a list */
export const getWaitlistAutoApproveDomains = (settings: Settings): string[] => {
  return settings.waitlistAutoApproveDomains
    .split(',')
    .map((domain) => domain.trim().toLowerCase())
    .filter((domain) => domain.length > 0)
}
