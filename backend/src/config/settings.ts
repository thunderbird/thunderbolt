import { z } from 'zod'

/**
 * Settings schema for environment variables validation
 */
const settingsSchema = z.object({
  // API Keys
  fireworksApiKey: z.string().default(''),
  mistralApiKey: z.string().default(''),
  anthropicApiKey: z.string().default(''),
  exaApiKey: z.string().default(''),
  thunderboltInferenceUrl: z.string().default(''),
  thunderboltInferenceApiKey: z.string().default(''),

  // Health Check Configuration
  monitoringToken: z.string().default(''),

  // OAuth Settings
  googleClientId: z.string().default(''),
  googleClientSecret: z.string().default(''),
  microsoftClientId: z.string().default(''),
  microsoftClientSecret: z.string().default(''),

  // OIDC Settings (enterprise self-hosted)
  authMode: z.enum(['consumer', 'oidc']).default('consumer'),
  oidcClientId: z.string().default(''),
  oidcClientSecret: z.string().default(''),
  oidcIssuer: z.string().default(''),
  betterAuthUrl: z.string().default('http://localhost:8000'),
  betterAuthSecret: z.string().min(1),

  // General settings
  logLevel: z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR']).default('INFO'),
  port: z.coerce.number().default(8000),
  appUrl: z.string().default('http://localhost:1420'),

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
  powersyncTokenExpirySeconds: z.coerce.number().default(3600),

  // CORS settings — comma-separated list of exact origins
  corsOrigins: z.string().default('http://localhost:1420,tauri://localhost,http://tauri.localhost'),
  corsAllowCredentials: z.boolean().default(true),
  corsAllowMethods: z.string().default('GET,POST,PUT,DELETE,PATCH,OPTIONS'),
  corsAllowHeaders: z
    .string()
    .default(
      'Content-Type,Authorization,Accept,Accept-Encoding,Accept-Language,Cache-Control,User-Agent,X-Requested-With,X-Client-Platform,X-Device-ID,X-Device-Name,X-Mcp-Target-Url,Mcp-Authorization,Mcp-Session-Id,Mcp-Protocol-Version',
    ),
  corsExposeHeaders: z
    .string()
    .default('mcp-session-id,set-auth-token,ratelimit-limit,ratelimit-remaining,ratelimit-reset,retry-after'),

  swaggerEnabled: z.boolean().default(false),

  // Rate limiting
  rateLimitEnabled: z.boolean().default(true),

  // Trusted proxy (controls which proxy headers are trusted for IP extraction)
  // Set to 'cloudflare' to trust CF-Connecting-IP, 'akamai' for True-Client-IP,
  // or leave empty to use only the direct socket IP (proxy headers are NOT trusted)
  trustedProxy: z.enum(['', 'cloudflare', 'akamai']).default(''),
})

export type Settings = z.infer<typeof settingsSchema>

/**
 * Parse and validate environment variables into settings
 */
const parseSettings = (): Settings => {
  const env = {
    fireworksApiKey: process.env.FIREWORKS_API_KEY || '',
    mistralApiKey: process.env.MISTRAL_API_KEY || '',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    exaApiKey: process.env.EXA_API_KEY || '',
    thunderboltInferenceUrl: process.env.THUNDERBOLT_INFERENCE_URL || '',
    thunderboltInferenceApiKey: process.env.THUNDERBOLT_INFERENCE_API_KEY || '',
    monitoringToken: process.env.MONITORING_TOKEN || '',
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    microsoftClientId: process.env.MICROSOFT_CLIENT_ID || '',
    microsoftClientSecret: process.env.MICROSOFT_CLIENT_SECRET || '',
    authMode: (process.env.AUTH_MODE || 'consumer').toLowerCase(),
    oidcClientId: process.env.OIDC_CLIENT_ID || '',
    oidcClientSecret: process.env.OIDC_CLIENT_SECRET || '',
    oidcIssuer: process.env.OIDC_ISSUER || '',
    betterAuthUrl: process.env.BETTER_AUTH_URL || 'http://localhost:8000',
    betterAuthSecret: process.env.BETTER_AUTH_SECRET,
    logLevel: (process.env.LOG_LEVEL || 'INFO').toUpperCase(),
    port: process.env.PORT || '8000',
    appUrl: process.env.APP_URL || 'http://localhost:1420',
    posthogHost: process.env.POSTHOG_HOST || 'https://us.i.posthog.com',
    posthogApiKey: process.env.POSTHOG_API_KEY || '',
    waitlistEnabled: process.env.WAITLIST_ENABLED === 'true',
    waitlistAutoApproveDomains: process.env.WAITLIST_AUTO_APPROVE_DOMAINS || '',
    powersyncUrl: process.env.POWERSYNC_URL || '',
    powersyncJwtKid: process.env.POWERSYNC_JWT_KID || '',
    powersyncJwtSecret: process.env.POWERSYNC_JWT_SECRET || '',
    powersyncTokenExpirySeconds: process.env.POWERSYNC_TOKEN_EXPIRY_SECONDS || '3600',
    corsOrigins: process.env.CORS_ORIGINS || 'http://localhost:1420,tauri://localhost,http://tauri.localhost',
    corsAllowCredentials: process.env.CORS_ALLOW_CREDENTIALS !== 'false',
    corsAllowMethods: process.env.CORS_ALLOW_METHODS || 'GET,POST,PUT,DELETE,PATCH,OPTIONS',
    corsAllowHeaders:
      process.env.CORS_ALLOW_HEADERS ||
      'Content-Type,Authorization,Accept,Accept-Encoding,Accept-Language,Cache-Control,User-Agent,X-Requested-With,X-Client-Platform,X-Device-ID,X-Device-Name,X-Mcp-Target-Url,Mcp-Authorization,Mcp-Session-Id,Mcp-Protocol-Version',
    corsExposeHeaders:
      process.env.CORS_EXPOSE_HEADERS ||
      'mcp-session-id,set-auth-token,ratelimit-limit,ratelimit-remaining,ratelimit-reset,retry-after',
    swaggerEnabled: process.env.SWAGGER_ENABLED === 'true',
    rateLimitEnabled: process.env.RATE_LIMIT_ENABLED !== 'false',
    trustedProxy: (process.env.TRUSTED_PROXY || '').toLowerCase(),
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

export const getCorsMethodsList = (settings: Settings): string[] => {
  return settings.corsAllowMethods
    .split(',')
    .map((method) => method.trim())
    .filter((method) => method.length > 0)
}

/** Parse comma-separated auto-approved domains into a list */
export const getWaitlistAutoApproveDomains = (settings: Settings): string[] => {
  return settings.waitlistAutoApproveDomains
    .split(',')
    .map((domain) => domain.trim().toLowerCase())
    .filter((domain) => domain.length > 0)
}
