/**
 * Providers
 *
 * External service integrations for evaluation tracking.
 *
 * ## Usage
 *
 * ```typescript
 * import { getProvider, listProviders } from './providers'
 *
 * // Get a specific provider
 * const provider = getProvider('langsmith', { verbose: true })
 * await provider.initialize()
 *
 * // List all providers
 * const providers = listProviders()
 * ```
 *
 * ## Adding a New Provider
 *
 * See `registry.ts` for instructions.
 */

// Registry API (main exports)
export {
  getProvider,
  listProviders,
  getConfiguredProviders,
  isProviderConfigured,
  printProviderStatus,
  registry,
  type ProviderRegistration,
  type ProviderOptions,
  type ProviderStatus,
} from './registry'

// Individual providers (for direct use if needed)
export { ConsoleProvider } from './console'
export { HeliconeProvider } from './helicone'
export { LangSmithProvider } from './langsmith'
