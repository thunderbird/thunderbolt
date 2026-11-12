/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { useState } from 'react'
import type { Device } from '@/dal'
import type { DeviceApprovalConfirmation } from '@/services/encryption'
import { Smartphone } from 'lucide-react'

import { ApproveDeviceDialog } from '@/components/approve-device'
import { RevokeDeviceDialog } from '@/components/revoke-device-dialog'
import { Button } from '@/components/ui/button'
import { ResponsiveModal, ResponsiveModalContent, ResponsiveModalTitle } from '@/components/ui/responsive-modal'
import { IconCircle } from '@/components/onboarding/icon-circle'
import { useApproveDevice } from '@/hooks/use-approve-device'
import { useDeviceKeyTrust } from '@/hooks/use-e2ee-ready'
import { useDenyDevice } from '@/hooks/use-deny-device'
import { usePendingDeviceNotification } from '@/hooks/use-pending-device-notification'
import { useLocalSettingsStore } from '@/stores/local-settings-store'

export const PendingDeviceModal = () => {
  const syncEnabled = useLocalSettingsStore((state) => state.syncEnabled)
  return syncEnabled ? <SyncedPendingDeviceModal /> : null
}

const SyncedPendingDeviceModal = () => {
  const { pendingDeviceToNotify } = usePendingDeviceNotification()
  const [approvalTarget, setApprovalTarget] = useState<Device | null>(null)
  /** The device the deny confirmation acts on: the one being approved, not whichever is newest by then. */
  const [denyTarget, setDenyTarget] = useState<Device | null>(null)

  const approveMutation = useApproveDevice()
  const denyMutation = useDenyDevice()
  const { unverified } = useDeviceKeyTrust()
  // A device that can't approve may set the prompt aside for that pending
  // device; Settings → Devices still lists it, with Deny.
  const [dismissedId, setDismissedId] = useState<string | null>(null)

  const isOpen = pendingDeviceToNotify !== null && !(unverified && dismissedId === pendingDeviceToNotify.id)

  const confirmApprove = async (confirmation: DeviceApprovalConfirmation) => {
    if (!approvalTarget) {
      return
    }
    await approveMutation.mutateAsync({ device: approvalTarget, confirmation })
    setApprovalTarget(null)
  }

  const denyFromApproval = () => {
    setDenyTarget(approvalTarget)
    setApprovalTarget(null)
  }

  const confirmDeny = () => {
    if (!denyTarget) {
      return
    }
    denyMutation.mutate(denyTarget.id, {
      onSuccess: () => setDenyTarget(null),
    })
  }

  return (
    <>
      <ResponsiveModal
        open={isOpen}
        onOpenChange={(open) => !open && unverified && setDismissedId(pendingDeviceToNotify?.id ?? null)}
        className="sm:min-h-0 sm:h-auto"
        showCloseButton={unverified}
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => !unverified && e.preventDefault()}
      >
        <ResponsiveModalContent>
          <div className="w-full flex flex-col">
            <div className="text-center space-y-4">
              <IconCircle>
                <Smartphone className="w-8 h-8 text-primary" />
              </IconCircle>
              <ResponsiveModalTitle className="text-2xl font-bold leading-normal">
                <Trans>New device waiting</Trans>
              </ResponsiveModalTitle>
              <p className="text-muted-foreground">
                <Trans>A new device is requesting access to your encrypted data.</Trans>
              </p>

              {pendingDeviceToNotify && (
                <div className="flex items-center gap-3 rounded-lg border bg-secondary/50 p-4 text-left">
                  <Smartphone className="size-5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <span className="font-medium truncate">{pendingDeviceToNotify.name}</span>
                    <p className="text-sm text-muted-foreground">
                      <Trans>Waiting for approval</Trans>
                    </p>
                  </div>
                </div>
              )}
            </div>

            <div className="pt-5 flex flex-col gap-2">
              {unverified && (
                <p id="pending-device-approve-blocked" className="text-sm text-muted-foreground">
                  <Trans>
                    This device can't approve other devices because its encryption keys couldn't be verified. Approve
                    from a device that was trusted before.
                  </Trans>
                </p>
              )}
              <Button
                className="w-full"
                disabled={unverified}
                aria-describedby={unverified ? 'pending-device-approve-blocked' : undefined}
                onClick={() => pendingDeviceToNotify && setApprovalTarget({ ...pendingDeviceToNotify })}
              >
                <Trans>Approve</Trans>
              </Button>
              <Button className="w-full" variant="ghost" onClick={() => setDenyTarget(pendingDeviceToNotify)}>
                <span className="text-destructive">
                  <Trans>Deny</Trans>
                </span>
              </Button>
            </div>
          </div>
        </ResponsiveModalContent>
      </ResponsiveModal>

      {/*
        Both dialogs render their own failure (THU-887). This surface needs it
        more than the settings page does: on a device that can approve, the
        modal behind them cannot be dismissed at all — no close button, escape
        and outside-click both prevented — so a silent no-op here leaves the user
        with nothing to do and nothing to read. `useApproveDevice` throws a real error on a device
        with missing public keys.
      */}
      <ApproveDeviceDialog
        device={approvalTarget}
        open={approvalTarget !== null}
        onOpenChange={(open) => !open && setApprovalTarget(null)}
        onConfirm={confirmApprove}
        onDeny={denyFromApproval}
        isPending={approveMutation.isPending}
      />

      <RevokeDeviceDialog
        open={denyTarget !== null}
        onOpenChange={(open) => !open && setDenyTarget(null)}
        onConfirm={confirmDeny}
        isPending={denyMutation.isPending}
        variant="pending"
        error={denyMutation.error?.message}
      />
    </>
  )
}
