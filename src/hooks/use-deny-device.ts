import { useHttpClient } from '@/contexts'
import { denyDevice } from '@/api/encryption'
import { useMutation } from '@tanstack/react-query'

/**
 * Mutation for denying a pending device without revoking it.
 * Sets approval_pending = false so the device disappears from the pending list
 * but stays registered and can re-request approval.
 */
export const useDenyDevice = () => {
  const httpClient = useHttpClient()

  return useMutation({
    mutationFn: (deviceId: string) => denyDevice(httpClient, deviceId),
  })
}
