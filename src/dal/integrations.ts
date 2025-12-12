import { getSettings } from './settings'

/**
 * Available integrations. Add new integrations here.
 * Settings keys follow the pattern: `integrations_{id}_credentials` and `integrations_{id}_is_enabled`
 */
export const INTEGRATIONS = ['google', 'microsoft'] as const

export type IntegrationId = (typeof INTEGRATIONS)[number]

/** Status of a connected integration. Presence in the result implies connected. */
export type IntegrationStatus = {
  enabled: boolean
}

/** Map of connected integrations to their status. If an integration is not in the map, it's not connected. */
export type IntegrationStatuses = Partial<Record<IntegrationId, IntegrationStatus>> & {
  doNotAskAgain: boolean
}

/** Builds the settings schema dynamically based on INTEGRATIONS */
const buildSettingsSchema = (integrations: readonly IntegrationId[]) => {
  const schema: Record<string, string | boolean> = {
    integrations_do_not_ask_again: false,
  }
  for (const id of integrations) {
    schema[`integrations_${id}_credentials`] = ''
    schema[`integrations_${id}_is_enabled`] = false
  }
  return schema
}

/** Converts snake_case key part to camelCase accessor */
const toCamelCase = (id: string) => id.charAt(0).toUpperCase() + id.slice(1)

/**
 * Gets statuses for connected integrations only.
 * If an integration is not in the result, it's not connected.
 *
 * @example
 * ```ts
 * const statuses = await getIntegrationStatuses()
 * // Only connected integrations are included:
 * // { google: { enabled: true }, doNotAskAgain: false }
 *
 * // Check if connected:
 * if (statuses.google) { ... }
 * ```
 */
export const getIntegrationStatuses = async (integrations?: IntegrationId[]): Promise<IntegrationStatuses> => {
  const requested = integrations ?? INTEGRATIONS
  const settings = await getSettings(buildSettingsSchema(requested))

  const result: IntegrationStatuses = {
    doNotAskAgain: settings.integrationsDoNotAskAgain as boolean,
  }

  for (const id of requested) {
    const camelId = toCamelCase(id)
    const credentialsKey = `integrations${camelId}Credentials` as keyof typeof settings
    const enabledKey = `integrations${camelId}IsEnabled` as keyof typeof settings

    const isConnected = !!settings[credentialsKey]
    if (isConnected) {
      result[id] = {
        enabled: settings[enabledKey] as boolean,
      }
    }
  }

  return result
}
