import { useState } from 'react'
import { Smartphone } from 'lucide-react'

import { ApproveDeviceDialog } from '@/components/approve-device-dialog'
import { Button } from '@/components/ui/button'
import { ResponsiveModal, ResponsiveModalContent } from '@/components/ui/responsive-modal'
import { IconCircle } from '@/components/onboarding/icon-circle'
import { useApproveDevice } from '@/hooks/use-approve-device'
import { usePendingDeviceNotification } from '@/hooks/use-pending-device-notification'

export const PendingDeviceModal = () => {
  const { pendingDeviceToNotify, dismissDevice, pendingDevices } = usePendingDeviceNotification()
  const [confirmOpen, setConfirmOpen] = useState(false)

  const approveMutation = useApproveDevice(pendingDevices)

  const isOpen = pendingDeviceToNotify !== null

  const handleDismiss = () => {
    if (pendingDeviceToNotify) {
      dismissDevice(pendingDeviceToNotify.id)
    }
  }

  const confirmApprove = () => {
    if (!pendingDeviceToNotify) {
      return
    }
    approveMutation.mutate(pendingDeviceToNotify.id, {
      onSuccess: () => {
        setConfirmOpen(false)
        dismissDevice(pendingDeviceToNotify.id)
      },
    })
  }

  return (
    <>
      <ResponsiveModal open={isOpen} onOpenChange={(open) => !open && handleDismiss()} className="sm:min-h-0 sm:h-auto">
        <ResponsiveModalContent>
          <div className="w-full flex flex-col">
            <div className="text-center space-y-4">
              <IconCircle>
                <Smartphone className="w-8 h-8 text-primary" />
              </IconCircle>
              <h2 className="text-2xl font-bold">New device waiting</h2>
              <p className="text-muted-foreground">A new device is requesting access to your encrypted data.</p>

              {pendingDeviceToNotify && (
                <div className="flex items-center gap-3 rounded-lg border bg-secondary/50 p-4 text-left">
                  <Smartphone className="size-5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <span className="font-medium truncate">{pendingDeviceToNotify.name}</span>
                    <p className="text-sm text-muted-foreground">Waiting for approval</p>
                  </div>
                </div>
              )}
            </div>

            <div className="pt-5 flex flex-col gap-2">
              <Button className="w-full" onClick={() => setConfirmOpen(true)}>
                Approve
              </Button>
              <Button className="w-full" variant="ghost" onClick={handleDismiss}>
                Later
              </Button>
            </div>
          </div>
        </ResponsiveModalContent>
      </ResponsiveModal>

      <ApproveDeviceDialog
        open={confirmOpen}
        onOpenChange={(open) => !open && setConfirmOpen(false)}
        onConfirm={confirmApprove}
        isPending={approveMutation.isPending}
      />
    </>
  )
}
