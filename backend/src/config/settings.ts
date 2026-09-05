/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { httpUrlField, type PublicMiniApp } from '@shared/mini-app-registry'
import { z } from 'zod'
import { inferenceUsageReceiptHeader } from '@shared/inference-usage'

const betterAuthTimeString = z.string().regex(/^\d+[smhd]$/, {
  message: 'must be a Better Auth time string (digits followed by s, m, h, or d)',
})
const defaultCorsExposeHeaders = `set-auth-token,X-Proxy-Final-Url,X-Proxy-Passthrough-Content-Type,X-Proxy-Passthrough-Mcp-Session-Id,X-Proxy-Passthrough-Mcp-Protocol-Version,X-Proxy-Passthrough-Location,X-Proxy-Passthrough-Anthropic-Version,WWW-Authenticate,Ehbp-Response-Nonce,X-Proxy-Timing,Server-Timing,${inferenceUsageReceiptHeader}`

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

    // Device Authorization Grant (RFC 8628) — used by the `thunderbolt` CLI to log in
    // headless. `deviceAuthExpiresIn` is how long the device/user code stays valid before
    // the CLI must restart the flow; `deviceAuthInterval` is the minimum client polling
    // gap. Better Auth time strings ('30m', '5s', '1h'). Defaults follow RFC 8628 §3.2.
    deviceAuthExpiresIn: betterAuthTimeString.default('30m'),
    deviceAuthInterval: betterAuthTimeString.default('5s'),

    // Better Auth API-key expiry values use seconds at runtime. New PATs expire after
    // 90 days by default; callers may request a different supported lifetime at creation.
    apiKeyDefaultExpiresInSeconds: z.coerce
      .number()
      .int()
      .positive()
      .default(90 * 24 * 60 * 60),

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

    /**
     * The Mini App registry, as JSON, keyed by app id:
     *
     * ```
     * { "order-book": { "name": "Order Book", "description": "…",
     *   "icon": "table", "url": "https://…", "origin": "https://…", "secret": "…" } }
     * ```
     *
     * One config, not two. An earlier cut kept presentation in a hardcoded
     * frontend array and only the audience here, which meant two lists of the
     * same apps that could disagree — and the failure was silent: an app the
     * backend didn't know about rendered fine and then couldn't authenticate.
     * The frontend now reads this over `GET /mini-apps`, minus the secret.
     *
     * `origin` becomes the `aud` of the identity token we mint, so it has to be
     * operator-declared — a client that could name its own audience could mint a
     * token for any app.
     *
     * Secrets are per app rather than one shared key: with a single symmetric
     * secret, any Mini App could forge a token for any other. Asymmetric keys
     * plus a JWKS endpoint are the upgrade once apps are built by third parties
     * and secret distribution stops being a deploy-time detail.
     */
    miniApps: z.string().default(''),
    /**
     * Lifetime of a Mini App identity token. Short by intent — the guest asks
     * for a new one as it nears expiry, so the blast radius of a leaked token is
     * minutes rather than the length of a session.
     */
    miniAppTokenExpirySeconds: z.coerce.number().int().positive().default(300),

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
    corsExposeHeaders: z.string().default(defaultCorsExposeHeaders),

    // E2E encryption — when true, devices must complete the trust flow before syncing
    e2eeEnabled: z.boolean().default(false),

    // Rollout order: docs/self-hosting/configuration.md#cli-device-rollout.
    // Kill switch for the server-owned CLI device row.
    cliDeviceRegistrationEnabled: z.boolean().default(false),

    // Minimum app version clients must run. Empty string disables enforcement.
    // Surfaced to the frontend via GET /config; clients below this hard-block until they update.
    // Trimmed + semver-validated at startup so typos (`banana`, `0,2,0`) fail fast
    // instead of reaching every client and breaking the version comparison.
    minAppVersion: z
      .string()
      .trim()
      .default('')
      .refine((v) => v === '' || /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(v), {
        message: 'MIN_APP_VERSION must be empty or a semver string (e.g. "0.2.0")',
      }),

    swaggerEnabled: z.boolean().default(false),

    // Rate limiting
    rateLimitEnabled: z.boolean().default(true),

    // Managed inference rolling quotas (integer cents)
    inferenceQuotaAnonymousFiveHourCents: z.coerce.number().int().positive().default(10),
    inferenceQuotaAnonymousSevenDayCents: z.coerce.number().int().positive().default(60),
    inferenceQuotaRegisteredFiveHourCents: z.coerce.number().int().positive().default(1500),
    inferenceQuotaRegisteredSevenDayCents: z.coerce.number().int().positive().default(7500),

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

/** One registered Mini App, as the backend holds it. */
export type MiniAppConfig = {
  name: string
  description: string
  /** Icon key the frontend maps to a component; unknown keys fall back. */
  icon: string
  /**
   * Exact origin the frame posts from, and the token's `aud`. Separate from
   * `url` on purpose: a redirect can move `url`, and the value we validate
   * against must be the one an operator declared.
   */
  origin: string
  /** Full URL loaded into the frame. Defaults to `origin`. */
  url: string
  /** HS256 signing secret, unique to this app. Never leaves the backend. */
  secret: string
}

/** What the frontend is allowed to see — everything but the secret. */
export type { PublicMiniApp }

/**
 * Normalised to a serialized origin, because that is what the browser reports
 * in `event.origin` — never with a path, never with a trailing slash. The
 * bridge compares the two with `===`, so an operator writing
 * `https://app.example.com/` used to produce an app that loaded and then
 * silently ignored every message it sent.
 */
const originField = httpUrlField.transform((value) => new URL(value).origin)

const miniAppEntrySchema = z
  .object({
    name: z.string().min(1),
    description: z.string().default(''),
    icon: z.string().default(''),
    origin: originField,
    url: httpUrlField.optional(),
    // Matches the 32-character floor the rest of the codebase holds signing
    // secrets to; this one signs identity tokens apps trust.
    secret: z.string().min(32),
  })
  // `url` is almost always the origin; making operators repeat it is a
  // second place for the two to disagree.
  .transform((app) => ({ ...app, url: app.url ?? app.origin }))

/**
 * Parse `miniApps`, dropping anything malformed rather than throwing.
 *
 * Validated per entry, which is what the promise below actually requires: a
 * typo in one app shouldn't take down token minting for the others. Parsing the
 * whole record in one go meant exactly that — a single bad entry produced an
 * empty registry and every app vanished at once.
 *
 * A dropped entry fails closed: that app simply can't get a token, which
 * surfaces as a clear 404 rather than a token signed with `undefined`. Each one
 * is logged, because an app quietly missing from the sidebar is otherwise a
 * long afternoon.
 *
 * A `Map`, not a plain object, because the only thing that ever looks an app up
 * is `POST /mini-apps/:appId/token` with an id straight off the URL. Indexing an
 * object literal with that made `/mini-apps/toString/token` (or `constructor`,
 * `valueOf`, `hasOwnProperty`) resolve to an inherited function — truthy, so the
 * 404 guard never fired and the route fell through to signing a token whose
 * `aud` and secret were both `undefined`. A `Map` only ever returns what was
 * `set` on it, so the whole class of bug is gone rather than guarded against.
 */
export const getMiniApps = (settings: Pick<Settings, 'miniApps'>): Map<string, MiniAppConfig> => {
  if (!settings.miniApps) {
    return new Map()
  }
  // `JSON.parse` throws on malformed input, so it can't go straight into
  // `safeParse` — a stray comma in an env var would take the process down.
  let container: unknown
  try {
    container = JSON.parse(settings.miniApps)
  } catch {
    console.error('[mini-apps] MINI_APPS is not valid JSON; no apps registered')
    return new Map()
  }
  if (typeof container !== 'object' || container === null || Array.isArray(container)) {
    console.error('[mini-apps] MINI_APPS must be an object keyed by app id; no apps registered')
    return new Map()
  }

  const entries = Object.entries(container).flatMap(([id, raw]) => {
    const app = miniAppEntrySchema.safeParse(raw)
    if (!app.success) {
      const why = app.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')
      console.error(`[mini-apps] Dropping "${id}" — ${why}`)
      return []
    }
    return [[id, app.data] as const]
  })
  return new Map(entries)
}

/**
 * The registry as the frontend receives it, with secrets stripped.
 *
 * Takes an already-parsed registry rather than `Settings`, so a route can parse
 * once at construction and answer from that. Deriving it from `Settings` per
 * call re-ran `JSON.parse` and the per-entry validation on every request — and
 * re-emitted the "Dropping <id>" log each time, which on an unauthenticated
 * route means any caller can drive the log volume.
 */
export const toPublicMiniApps = (apps: ReadonlyMap<string, MiniAppConfig>): PublicMiniApp[] =>
  [...apps].map(([id, { secret: _secret, ...app }]) => ({ id, ...app }))

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
    deviceAuthExpiresIn: process.env.DEVICE_AUTH_EXPIRES_IN || '30m',
    deviceAuthInterval: process.env.DEVICE_AUTH_INTERVAL || '5s',
    apiKeyDefaultExpiresInSeconds: process.env.API_KEY_DEFAULT_EXPIRES_IN,
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
    /*
     * The dev fallback is the starter template, and only the starter template.
     *
     * It used to register two apps that live outside this repo, on ports a fresh
     * checkout has nothing running on — so `bun dev` gave you a sidebar of apps
     * that could not load, and it disagreed with the `MINI_APPS` line in
     * `.env.example`. Two defaults for one setting is the same "two lists that
     * can disagree" problem this field's own docs are about, and the loser was
     * whoever hadn't copied the example file.
     */
    miniApps:
      process.env.MINI_APPS ||
      (isDevelopment
        ? JSON.stringify({
            'order-book': {
              name: 'Order Book',
              description: 'Template starter app — orders with a changeable status.',
              icon: 'table',
              origin: 'http://localhost:5190',
              secret: 'order-book-template-dev-secret-xx',
            },
          })
        : ''),
    miniAppTokenExpirySeconds: Number(process.env.MINI_APP_TOKEN_EXPIRY_SECONDS) || 300,
    powersyncJwtKid: process.env.POWERSYNC_JWT_KID || (isDevelopment ? 'powersync-dev' : ''),
    powersyncJwtSecret:
      process.env.POWERSYNC_JWT_SECRET || (isDevelopment ? 'powersync-dev-secret-change-in-production' : ''),
    powersyncTokenExpirySeconds: process.env.POWERSYNC_TOKEN_EXPIRY_SECONDS || '3600',
    corsOrigins: process.env.CORS_ORIGINS || 'http://localhost:1420,tauri://localhost,http://tauri.localhost',
    corsAllowCredentials: process.env.CORS_ALLOW_CREDENTIALS !== 'false',
    corsAllowMethods: process.env.CORS_ALLOW_METHODS || 'GET,POST,PUT,DELETE,PATCH,OPTIONS',
    corsAllowHeaders: process.env.CORS_ALLOW_HEADERS || '',
    corsExposeHeaders: process.env.CORS_EXPOSE_HEADERS || defaultCorsExposeHeaders,
    e2eeEnabled: process.env.E2EE_ENABLED === 'true',
    cliDeviceRegistrationEnabled: process.env.CLI_DEVICE_REGISTRATION_ENABLED === 'true',
    minAppVersion: process.env.MIN_APP_VERSION || '',
    swaggerEnabled: process.env.SWAGGER_ENABLED === 'true',
    rateLimitEnabled: process.env.RATE_LIMIT_ENABLED !== 'false',
    inferenceQuotaAnonymousFiveHourCents: process.env.INFERENCE_QUOTA_ANONYMOUS_5H_CENTS,
    inferenceQuotaAnonymousSevenDayCents: process.env.INFERENCE_QUOTA_ANONYMOUS_7D_CENTS,
    inferenceQuotaRegisteredFiveHourCents: process.env.INFERENCE_QUOTA_REGISTERED_5H_CENTS,
    inferenceQuotaRegisteredSevenDayCents: process.env.INFERENCE_QUOTA_REGISTERED_7D_CENTS,
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

/**
 * Whether a request's `Origin` header is one we serve.
 *
 * Absence is allowed: a same-origin or non-browser caller sends no `Origin`, and
 * every route using this authorises with a session or a token as well — this
 * only refuses a *browser* on an origin we don't serve. Two routes had their own
 * copy of exactly this, which is one copy too many for a security predicate.
 */
export const isRequestOriginAllowed = (request: Request, settings: Pick<Settings, 'corsOrigins'>): boolean => {
  const origin = request.headers.get('origin')
  return !origin || isOriginAllowed(origin, settings)
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
