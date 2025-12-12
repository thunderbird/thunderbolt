import { getIntegrationStatuses, type IntegrationId, type IntegrationStatuses } from '@/dal/integrations'
import { useQuery } from '@tanstack/react-query'

export type { IntegrationId, IntegrationStatuses }

/**
 * Hook to get integration statuses.
 * If no integrations are specified, returns status for all integrations.
 *
 * @example
 * ```tsx
 * // Get all integration statuses
 * const { data: statuses } = useIntegrationStatuses()
 * // statuses?.google?.enabled (if google exists, it's connected)
 *
 * // Get specific integration status
 * const { data: statuses } = useIntegrationStatuses(['google'])
 * ```
 */
export const useIntegrationStatuses = (integrations?: IntegrationId[]) => {
  const query = useQuery({
    queryKey: ['integrationStatuses', integrations],
    queryFn: () => getIntegrationStatuses(integrations),
  })

  return {
    data: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error as Error | null,
  }
}
