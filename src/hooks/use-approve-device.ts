import { useHttpClient } from '@/contexts'
import type { Device } from '@/dal'
import { approveDevice } from '@/services/encryption'
import { useMutation } from '@tanstack/react-query'

/**
 * Shared mutation for approving a pending device.
 * Used by both the pending device modal and the devices settings page.
 */
export const useApproveDevice = (pendingDevices: Device[]) => {
  const httpClient = useHttpClient()

  return useMutation({
    mutationFn: async (deviceId: string) => {
      const device = pendingDevices.find((d) => d.id === deviceId)
      if (!device?.publicKey) {
        throw new Error('Device has no public key')
      }
      await approveDevice(httpClient, deviceId, device.publicKey)
    },
  })
}
