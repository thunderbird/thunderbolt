import { useHttpClient } from '@/contexts'
import { authHeaders } from '@/api/encryption'
import { useMutation } from '@tanstack/react-query'

/**
 * Shared mutation for revoking a device (trusted or pending).
 * Used by both the pending device modal and the devices settings page.
 */
export const useRevokeDevice = () => {
  const httpClient = useHttpClient()

  return useMutation({
    mutationFn: (deviceId: string) =>
      httpClient
        .post(`account/devices/${encodeURIComponent(deviceId)}/revoke`, {
          headers: authHeaders(),
          credentials: 'omit',
        })
        .then(() => {}),
  })
}
