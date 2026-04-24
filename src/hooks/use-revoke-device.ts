import { useHttpClient } from '@/contexts'
import { revokeDeviceWithProof } from '@/services/encryption'
import { useMutation } from '@tanstack/react-query'

/**
 * Mutation for revoking a device (trusted or pending).
 * Used by both the pending device modal and the devices settings page.
 * Requires proof-of-CK-possession (canary secret) to prevent session-theft attacks.
 */
export const useRevokeDevice = () => {
  const httpClient = useHttpClient()

  return useMutation({
    mutationFn: (deviceId: string) => revokeDeviceWithProof(httpClient, deviceId),
  })
}
