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

  // General settings
  logLevel: z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR']).default('INFO'),
  port: z.coerce.number().default(8000),

  // Analytics settings
  posthogHost: z.string().default('https://us.i.posthog.com'),
  posthogApiKey: z.string().default(''),

  // Waitlist settings
  waitlistEnabled: z.boolean().default(false),

  // PowerSync settings
  powersyncUrl: z.string().default(''),
  powersyncJwtKid: z.string().default(''),
  powersyncJwtSecret: z.string().default(''),
  powersyncTokenExpirySeconds: z.coerce.number().default(3600),

  // CORS settings
  corsOrigins: z.string().default('http://localhost:1420'),
  corsOriginRegex: z
    .string()
    .default('^(tauri://localhost|http://tauri\\.localhost|http://localhost:\\d+|null|file://.*)$'),
  corsAllowCredentials: z.boolean().default(true),
  corsAllowMethods: z.string().default('GET,POST,PUT,DELETE,PATCH,OPTIONS'),
  corsAllowHeaders: z
    .string()
    .default(
      'Content-Type,Authorization,Accept,Accept-Encoding,Accept-Language,Cache-Control,User-Agent,X-Requested-With,X-Client-Platform,X-Device-ID,X-Device-Name',
    ),
  corsExposeHeaders: z.string().default('mcp-session-id'),
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
    logLevel: (process.env.LOG_LEVEL || 'INFO').toUpperCase(),
    port: process.env.PORT || '8000',
    posthogHost: process.env.POSTHOG_HOST || 'https://us.i.posthog.com',
    posthogApiKey: process.env.POSTHOG_API_KEY || '',
    waitlistEnabled: process.env.WAITLIST_ENABLED === 'true',
    powersyncUrl: process.env.POWERSYNC_URL || '',
    powersyncJwtKid: process.env.POWERSYNC_JWT_KID || '',
    powersyncJwtSecret: process.env.POWERSYNC_JWT_SECRET || '',
    powersyncTokenExpirySeconds: process.env.POWERSYNC_TOKEN_EXPIRY_SECONDS || '3600',
    corsOrigins: process.env.CORS_ORIGINS || 'http://localhost:1420',
    corsOriginRegex:
      process.env.CORS_ORIGIN_REGEX ||
      '^(tauri://localhost|http://tauri\\.localhost|http://localhost:\\d+|null|file://.*)$',
    corsAllowCredentials: process.env.CORS_ALLOW_CREDENTIALS !== 'false',
    corsAllowMethods: process.env.CORS_ALLOW_METHODS || 'GET,POST,PUT,DELETE,PATCH,OPTIONS',
    corsAllowHeaders:
      process.env.CORS_ALLOW_HEADERS ||
      'Content-Type,Authorization,Accept,Accept-Encoding,Accept-Language,Cache-Control,User-Agent,X-Requested-With,X-Client-Platform,X-Device-ID,X-Device-Name',
    corsExposeHeaders: process.env.CORS_EXPOSE_HEADERS || 'mcp-session-id',
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

/**
 * Derived properties similar to the Python version
 */
export const getCorsOriginsList = (settings: Settings): string[] => {
  return settings.corsOrigins
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0)
}

/**
 * Get CORS origins as either a RegExp pattern or array of strings
 */
export const getCorsOrigins = (settings: Settings): RegExp | string[] => {
  return settings.corsOriginRegex ? new RegExp(settings.corsOriginRegex) : getCorsOriginsList(settings)
}

export const getCorsMethodsList = (settings: Settings): string[] => {
  return settings.corsAllowMethods
    .split(',')
    .map((method) => method.trim())
    .filter((method) => method.length > 0)
}
