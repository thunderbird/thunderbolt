/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useDatabase } from '@/contexts'
import { getAllDevices, getPendingDevices, type Device } from '@/dal'
import { getDeviceId } from '@/lib/auth-token'
import { PageHeader } from '@/components/ui/page-header'
import { ApproveDeviceDialog } from '@/components/approve-device-dialog'
import { RevokeDeviceDialog } from '@/components/revoke-device-dialog'
import { RemoveBridgeDialog } from '@/components/remove-bridge-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import dayjs from 'dayjs'
import { SectionCard } from '@/components/ui/section-card'
import { CheckCircle2, Link2, Loader2, QrCode, Smartphone, Trash2, Waypoints } from 'lucide-react'
import { lazy, Suspense, useState, type ReactNode } from 'react'
import { useQuery } from '@powersync/tanstack-react-query'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useApproveDevice } from '@/hooks/use-approve-device'
import { useDenyDevice } from '@/hooks/use-deny-device'
import { useRevokeDevice } from '@/hooks/use-revoke-device'
import { useRemoveDevice } from '@/hooks/use-remove-device'
import { useSetDeviceNodeId } from '@/hooks/use-set-device-node-id'
import { useDevicePairing } from '@/hooks/use-device-pairing'
import { encodePairingTicket } from '@/lib/pairing-ticket'
import { SettingsPageShell } from '@/components/settings/settings-list'
import { cn } from '@/lib/utils'

const DeviceQrCode = lazy(() => import('@/components/device-qr-code'))
const SetNodeIdDialog = lazy(() => import('@/components/set-node-id-dialog'))

type ConfirmationTarget = {
  action: 'approve' | 'deny' | 'remove' | 'revoke'
  deviceId: string
}

/** Compact card shell shared by the pending and trusted device rows. */
const DeviceCard = ({ className, children }: { className?: string; children: ReactNode }) => (
  <Card className={cn('py-3', className)}>
    <CardContent className="px-4">{children}</CardContent>
  </Card>
)

const formatLastSeen = (ts: string | null): string => {
  if (ts == null) {
    return '—'
  }
  const date = dayjs(ts)
  const now = dayjs()
  const diffMs = date.diff(now)
  return dayjs.duration(diffMs, 'millisecond').humanize(true)
}

type PendingDeviceRowProps = {
  device: Device
  isApprovePending: boolean
  isApprovingThisDevice: boolean
  isDenyPending: boolean
  onApprove: () => void
  onDeny: () => void
}

/** A device awaiting approval, with its deny/approve actions. */
const PendingDeviceRow = ({
  device,
  isApprovePending,
  isApprovingThisDevice,
  isDenyPending,
  onApprove,
  onDeny,
}: PendingDeviceRowProps) => (
  <DeviceCard className="bg-secondary/50">
    <div className="flex items-center justify-between gap-4">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Smartphone className="size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <span className="font-medium truncate">{device.name}</span>
          <p className="text-sm text-muted-foreground">Waiting for approval</p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onDeny} disabled={isDenyPending}>
          <Trash2 className="size-4 mr-1" />
          Deny
        </Button>
        <Button variant="default" size="sm" onClick={onApprove} disabled={isApprovePending}>
          {isApprovingThisDevice ? (
            <Loader2 className="size-4 mr-1 animate-spin" />
          ) : (
            <CheckCircle2 className="size-4 mr-1" />
          )}
          Approve
        </Button>
      </div>
    </div>
  </DeviceCard>
)

type TrustedDeviceRowProps = {
  device: Device
  isCurrent: boolean
  isQrVisible: boolean
  isRevokePending: boolean
  isRemovePending: boolean
  onRevoke: () => void
  onRemove: () => void
  onToggleQr: () => void
  onOpenPairingDialog: () => void
}

/** A trusted (or recently revoked) device with its badges, actions, and pairing identity. */
const TrustedDeviceRow = ({
  device,
  isCurrent,
  isQrVisible,
  isRevokePending,
  isRemovePending,
  onRevoke,
  onRemove,
  onToggleQr,
  onOpenPairingDialog,
}: TrustedDeviceRowProps) => {
  const isRevoked = device.revokedAt != null
  const isBridge = device.deviceType === 'bridge'
  return (
    <DeviceCard>
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {isBridge ? (
            <Waypoints className="size-5 shrink-0 text-muted-foreground" />
          ) : (
            <Smartphone className="size-5 shrink-0 text-muted-foreground" />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium truncate">{device.name}</span>
              {isBridge && (
                <span className="shrink-0 rounded-full bg-muted px-2 py-1 text-xs text-muted-foreground">Bridge</span>
              )}
              {isCurrent && (
                <span className="shrink-0 rounded-full bg-muted px-2 py-1 text-xs text-muted-foreground">
                  This Device
                </span>
              )}
              {isRevoked && (
                <span className="shrink-0 rounded-full bg-muted px-2 py-1 text-xs text-muted-foreground">Revoked</span>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              {isBridge ? 'Accepts connections from your devices' : `Last seen: ${formatLastSeen(device.lastSeen)}`}
            </p>
          </div>
        </div>
        {!isRevoked && !isCurrent && (
          <Button variant="ghost" size="sm" onClick={onRevoke} disabled={isRevokePending}>
            <Trash2 className="size-4 mr-1" />
            Revoke
          </Button>
        )}
        {isRevoked && isBridge && (
          <Button variant="ghost" size="sm" onClick={onRemove} disabled={isRemovePending}>
            <Trash2 className="size-4 mr-1" />
            Remove
          </Button>
        )}
      </div>

      {!isRevoked && (
        <div className="mt-3 flex flex-col gap-2 border-t pt-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <Link2 className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate font-mono text-[length:var(--font-size-xs)] text-muted-foreground">
                {device.nodeId ? device.nodeId : 'No pairing identity'}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {device.nodeId && (
                <Button variant="ghost" size="sm" onClick={onToggleQr}>
                  <QrCode className="size-4 mr-1" />
                  {isQrVisible ? 'Hide' : 'Show'}
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={onOpenPairingDialog}>
                {device.nodeId ? 'Update' : 'Set node ID'}
              </Button>
            </div>
          </div>
          {device.nodeId && isQrVisible && (
            <Suspense
              fallback={<p className="text-[length:var(--font-size-xs)] text-muted-foreground">Loading code…</p>}
            >
              <DeviceQrCode value={encodePairingTicket({ nodeId: device.nodeId, name: device.name })} />
            </Suspense>
          )}
        </div>
      )}
    </DeviceCard>
  )
}

export default function DevicesSettingsPage() {
  const db = useDatabase()
  const currentDeviceId = getDeviceId()
  const { data: devices = [], isLoading } = useQuery({
    queryKey: ['devices'],
    query: toCompilableQuery(getAllDevices(db)),
  })
  const { data: pendingDevices = [] } = useQuery({
    queryKey: ['pending-devices'],
    query: toCompilableQuery(getPendingDevices(db)),
  })
  const [confirmationTarget, setConfirmationTarget] = useState<ConfirmationTarget | null>(null)

  const visibleDevices = devices.filter((d) => {
    if (d.revokedAt != null) {
      return dayjs().diff(dayjs(d.revokedAt), 'hour') < 24
    }
    return !!d.trusted
  })

  const revokeMutation = useRevokeDevice()
  const removeMutation = useRemoveDevice()
  const denyMutation = useDenyDevice()
  const approveMutation = useApproveDevice(pendingDevices)
  const setNodeIdMutation = useSetDeviceNodeId()
  const pairing = useDevicePairing()

  const dialogDevice = devices.find((d) => d.id === pairing.dialogFor) ?? null

  const confirmSetNodeId = async (nodeId: string) => {
    if (!pairing.dialogFor) {
      return
    }
    await setNodeIdMutation.mutateAsync({ deviceId: pairing.dialogFor, nodeId })
    pairing.closeDialog()
  }

  /** Runs the confirmed action's mutation against the pending target, closing the dialog on success.
   *  The action guard makes a stale dialog's confirm a no-op if the target changed under it. */
  const confirmPendingAction = (
    action: ConfirmationTarget['action'],
    mutation: { mutate: (deviceId: string, options: { onSuccess: () => void }) => void },
  ) => {
    if (confirmationTarget?.action !== action) {
      return
    }
    mutation.mutate(confirmationTarget.deviceId, {
      onSuccess: () => setConfirmationTarget(null),
    })
  }

  const hasPendingDevices = pendingDevices.length > 0

  return (
    <SettingsPageShell className="gap-6 pb-12">
      <PageHeader title="Devices" />

      {removeMutation.error && (
        <p className="text-sm text-destructive" role="alert">
          {removeMutation.error.message}
        </p>
      )}

      {hasPendingDevices && (
        <>
          <SectionCard title="Pending Approvals">
            <div className="flex flex-col gap-3">
              {pendingDevices.map((device) => (
                <PendingDeviceRow
                  key={device.id}
                  device={device}
                  isApprovePending={approveMutation.isPending}
                  isApprovingThisDevice={approveMutation.isPending && approveMutation.variables === device.id}
                  isDenyPending={denyMutation.isPending}
                  onApprove={() => setConfirmationTarget({ action: 'approve', deviceId: device.id })}
                  onDeny={() => setConfirmationTarget({ action: 'deny', deviceId: device.id })}
                />
              ))}
            </div>
          </SectionCard>

          <div className="h-px bg-border" />
        </>
      )}

      {hasPendingDevices && <h3 className="text-lg font-semibold -mb-2">Trusted Devices</h3>}

      {isLoading ? (
        <p className="text-muted-foreground py-4">Loading devices…</p>
      ) : visibleDevices.length === 0 ? (
        <p className="text-muted-foreground py-4">No devices yet. Sign in with sync to see devices here.</p>
      ) : (
        <div className="flex flex-col gap-4">
          {visibleDevices.map((device) => (
            <TrustedDeviceRow
              key={device.id}
              device={device}
              isCurrent={device.id === currentDeviceId}
              isQrVisible={pairing.qrFor === device.id}
              isRevokePending={revokeMutation.isPending}
              isRemovePending={removeMutation.isPending}
              onRevoke={() => setConfirmationTarget({ action: 'revoke', deviceId: device.id })}
              onRemove={() => setConfirmationTarget({ action: 'remove', deviceId: device.id })}
              onToggleQr={() => pairing.toggleQr(device.id)}
              onOpenPairingDialog={() => pairing.openDialog(device.id)}
            />
          ))}
        </div>
      )}

      <ApproveDeviceDialog
        open={confirmationTarget?.action === 'approve'}
        onOpenChange={(open) => !open && setConfirmationTarget(null)}
        onConfirm={() => confirmPendingAction('approve', approveMutation)}
        isPending={approveMutation.isPending}
      />

      <RevokeDeviceDialog
        open={confirmationTarget?.action === 'revoke'}
        onOpenChange={(open) => !open && setConfirmationTarget(null)}
        onConfirm={() => confirmPendingAction('revoke', revokeMutation)}
        isPending={revokeMutation.isPending}
        variant="trusted"
      />

      <RevokeDeviceDialog
        open={confirmationTarget?.action === 'deny'}
        onOpenChange={(open) => !open && setConfirmationTarget(null)}
        onConfirm={() => confirmPendingAction('deny', denyMutation)}
        isPending={denyMutation.isPending}
        variant="pending"
      />

      <RemoveBridgeDialog
        open={confirmationTarget?.action === 'remove'}
        onOpenChange={(open) => !open && setConfirmationTarget(null)}
        onConfirm={() => confirmPendingAction('remove', removeMutation)}
        isPending={removeMutation.isPending}
      />

      {dialogDevice && (
        <Suspense fallback={null}>
          <SetNodeIdDialog
            key={dialogDevice.id}
            open
            onOpenChange={(open) => !open && pairing.closeDialog()}
            deviceName={dialogDevice.name}
            onConfirm={confirmSetNodeId}
            isPending={setNodeIdMutation.isPending}
          />
        </Suspense>
      )}
    </SettingsPageShell>
  )
}
