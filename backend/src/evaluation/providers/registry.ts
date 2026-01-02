/**
 * Provider Registry
 *
 * Central configuration for all evaluation providers.
 *
 * ## Adding a New Provider
 *
 * 1. Create your provider in `src/evaluation/providers/<name>/`
 * 2. Add an entry to the `registry` array below
 * 3. That's it! The CLI will automatically pick it up.
 *
 * @example
 * ```typescript
 * // Add to the registry array:
 * {
 *   name: 'my-provider',
 *   description: 'My custom provider',
 *   requiredEnv: 'MY_PROVIDER_API_KEY',
 *   optionalEnv: ['MY_PROVIDER_PROJECT'],
 *   create: (opts) => new MyProvider(opts),
 * }
 * ```
 */

import type { Provider } from '../core'

// =============================================================================
// TYPES
// =============================================================================

/**
 * Options passed to all provider factories
 */
export type ProviderOptions = {
  /** Enable verbose logging */
  verbose?: boolean
}

/**
 * Provider registration entry
 *
 * Each provider must define:
 * - `name`: Unique CLI identifier (e.g., `--provider langsmith`)
 * - `description`: Human-readable description for help text
 * - `requiredEnv`: Env var(s) that MUST be set for provider to work
 * - `optionalEnv`: Env var(s) that CAN be set (shown in docs)
 * - `create`: Factory function that creates the provider instance
 */
export type ProviderRegistration = {
  name: string
  description: string
  requiredEnv?: string | string[]
  optionalEnv?: string | string[]
  create: (options?: ProviderOptions) => Provider
}

/**
 * Provider status (returned by `listProviders`)
 */
export type ProviderStatus = {
  name: string
  description: string
  configured: boolean
  requiredEnv: string[]
  optionalEnv: string[]
  missingEnv: string[]
}

// =============================================================================
// REGISTRY
// =============================================================================

/**
 * Provider Registry
 *
 * Add new providers here. Order doesn't matter - providers are selected
 * explicitly by name via `--provider <name>`.
 */
export const registry: ProviderRegistration[] = [
  {
    name: 'langsmith',
    description: 'LangSmith for experiment tracking, datasets, and scoring',
    requiredEnv: 'LANGSMITH_API_KEY',
    optionalEnv: ['LANGSMITH_PROJECT', 'LANGSMITH_ENDPOINT'],
    create: (opts) => {
      const { LangSmithProvider } = require('./langsmith') as typeof import('./langsmith')
      return new LangSmithProvider(opts)
    },
  },
  {
    name: 'helicone',
    description: 'Helicone for observability and trace evaluation',
    requiredEnv: 'HELICONE_API_KEY',
    create: (opts) => {
      const { HeliconeProvider } = require('./helicone') as typeof import('./helicone')
      return new HeliconeProvider(opts)
    },
  },
  {
    name: 'console',
    description: 'Console output only (no external service)',
    create: (opts) => {
      const { ConsoleProvider } = require('./console') as typeof import('./console')
      return new ConsoleProvider(opts)
    },
  },
]

// =============================================================================
// HELPERS
// =============================================================================

/** Convert string or string[] to string[] */
const toArray = (value: string | string[] | undefined): string[] => {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

/** Check if all required env vars are set */
const checkEnvVars = (envVars: string[]): boolean => {
  return envVars.every((key) => !!process.env[key])
}

/** Get missing env vars from a list */
const findMissingEnvVars = (envVars: string[]): string[] => {
  return envVars.filter((key) => !process.env[key])
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Get a provider by name
 *
 * @param name - Provider name (e.g., 'langsmith', 'console')
 * @param options - Provider options
 * @throws Error if provider not found or not configured
 *
 * @example
 * ```typescript
 * const provider = getProvider('langsmith', { verbose: true })
 * await provider.initialize()
 * ```
 */
export const getProvider = (name: string, options?: ProviderOptions): Provider => {
  const registration = registry.find((r) => r.name === name)

  if (!registration) {
    const available = registry.map((r) => r.name).join(', ')
    throw new Error(`Unknown provider: "${name}". Available: ${available}`)
  }

  const required = toArray(registration.requiredEnv)
  const missing = findMissingEnvVars(required)

  if (missing.length > 0) {
    throw new Error(`Provider "${name}" requires: ${missing.join(', ')}`)
  }

  return registration.create(options)
}

/**
 * List all providers with their configuration status
 *
 * @example
 * ```typescript
 * const providers = listProviders()
 * providers.forEach(p => {
 *   console.log(`${p.name}: ${p.configured ? '✓' : '✗'}`)
 * })
 * ```
 */
export const listProviders = (): ProviderStatus[] => {
  return registry.map((reg) => {
    const required = toArray(reg.requiredEnv)
    return {
      name: reg.name,
      description: reg.description,
      configured: checkEnvVars(required),
      requiredEnv: required,
      optionalEnv: toArray(reg.optionalEnv),
      missingEnv: findMissingEnvVars(required),
    }
  })
}

/**
 * Get names of all configured (ready to use) providers
 */
export const getConfiguredProviders = (): string[] => {
  return listProviders()
    .filter((p) => p.configured)
    .map((p) => p.name)
}

/**
 * Check if a specific provider is configured
 */
export const isProviderConfigured = (name: string): boolean => {
  const status = listProviders().find((p) => p.name === name)
  return status?.configured ?? false
}

/**
 * Print provider status to console (for CLI `--list-providers`)
 */
export const printProviderStatus = (): void => {
  const providers = listProviders()

  console.log('')
  console.log('Available Providers:')
  console.log('')

  for (const p of providers) {
    const icon = p.configured ? '✅' : '❌'
    console.log(`  ${icon} ${p.name}`)
    console.log(`     ${p.description}`)

    if (p.requiredEnv.length > 0) {
      const status = p.requiredEnv.map((env) => `${env} ${process.env[env] ? '✓' : '✗'}`).join(', ')
      console.log(`     Required: ${status}`)
    } else {
      console.log(`     No configuration required`)
    }

    if (p.optionalEnv.length > 0) {
      const status = p.optionalEnv.map((env) => `${env} ${process.env[env] ? '✓' : '○'}`).join(', ')
      console.log(`     Optional: ${status}`)
    }

    console.log('')
  }
}
