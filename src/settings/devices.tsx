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
import { SettingsPageShell, SettingsSectionLabel } from '@/components/settings/settings-list'

const DeviceQrCode = lazy(() => import('@/components/device-qr-code'))
const SetNodeIdDialog = lazy(() => import('@/components/set-node-id-dialog'))

type ConfirmationTarget = {
  action: 'approve' | 'deny' | 'remove' | 'revoke'
  deviceId: string
}

/** Compact card shell shared by the pending and trusted device rows. */
const DeviceCard = ({ children }: { children: ReactNode }) => (
  <Card className="gap-0 border-border py-0">
    <CardContent className="px-4 py-3">{children}</CardContent>
  </Card>
)

/** Muted status pill next to a device name (Bridge / This device / Revoked). */
const DeviceBadge = ({ children }: { children: ReactNode }) => (
  <span className="shrink-0 rounded-full bg-muted px-2 py-1 text-xs text-muted-foreground">{children}</span>
)

/** Whether a device-id mutation is currently in flight for this specific device. */
const isMutatingDevice = (mutation: { isPending: boolean; variables: string | undefined }, deviceId: string) =>
  mutation.isPending && mutation.variables === deviceId

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
  isDenyingThisDevice: boolean
  onApprove: () => void
  onDeny: () => void
}

/** A device awaiting approval, with its deny/approve actions. */
const PendingDeviceRow = ({
  device,
  isApprovePending,
  isApprovingThisDevice,
  isDenyPending,
  isDenyingThisDevice,
  onApprove,
  onDeny,
}: PendingDeviceRowProps) => (
  <DeviceCard>
    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{device.name}</p>
        <p className="text-[length:var(--font-size-sm)] text-muted-foreground">Waiting for approval</p>
      </div>
      <div className="grid grid-cols-2 gap-2 md:flex md:shrink-0">
        <Button
          variant="outline"
          size="sm"
          aria-label={`Deny ${device.name}`}
          onClick={onDeny}
          disabled={isDenyPending}
          isLoading={isDenyingThisDevice}
          loadingLabel="Denying…"
        >
          Deny
        </Button>
        <Button
          size="sm"
          aria-label={`Approve ${device.name}`}
          onClick={onApprove}
          disabled={isApprovePending}
          isLoading={isApprovingThisDevice}
          loadingLabel="Approving…"
        >
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
  isRevokingThisDevice: boolean
  isRemovePending: boolean
  isRemovingThisDevice: boolean
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
  isRevokingThisDevice,
  isRemovePending,
  isRemovingThisDevice,
  onRevoke,
  onRemove,
  onToggleQr,
  onOpenPairingDialog,
}: TrustedDeviceRowProps) => {
  const isRevoked = device.revokedAt != null
  const isBridge = device.deviceType === 'bridge'
  const pairingPanelId = `device-pairing-${device.id}`
  return (
    <DeviceCard>
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 truncate font-medium">{device.name}</p>
            {isBridge && <DeviceBadge>Bridge</DeviceBadge>}
            {isCurrent && <DeviceBadge>This device</DeviceBadge>}
            {isRevoked && <DeviceBadge>Revoked</DeviceBadge>}
          </div>
          <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
            {isRevoked && isBridge
              ? 'No longer accepts device connections'
              : isBridge
                ? 'Accepts connections from your devices'
                : `Last seen ${formatLastSeen(device.lastSeen)}`}
          </p>
        </div>
        <div className="grid grid-cols-1 md:shrink-0">
          {!isRevoked && !isCurrent && (
            <Button
              variant="outline"
              size="sm"
              aria-label={`Revoke ${device.name}`}
              onClick={onRevoke}
              disabled={isRevokePending}
              isLoading={isRevokingThisDevice}
              loadingLabel="Revoking…"
            >
              Revoke
            </Button>
          )}
          {isRevoked && isBridge && (
            <Button
              variant="outline"
              size="sm"
              onClick={onRemove}
              disabled={isRemovePending}
              isLoading={isRemovingThisDevice}
              loadingLabel="Removing…"
            >
              Remove
            </Button>
          )}
        </div>
      </div>

      {!isRevoked && (
        <div className="mt-3 flex flex-col gap-2 border-t pt-3">
          <p className="text-[length:var(--font-size-xs)] font-medium uppercase tracking-wide text-muted-foreground">
            Pairing identity
          </p>
          <p className="break-all font-mono text-[length:var(--font-size-xs)] text-muted-foreground">
            {device.nodeId ?? 'Not configured'}
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:flex md:justify-end">
            {device.nodeId && (
              <Button
                variant="outline"
                size="sm"
                aria-label={`${isQrVisible ? 'Hide' : 'Show'} QR code for ${device.name}`}
                aria-expanded={isQrVisible}
                aria-controls={pairingPanelId}
                onClick={onToggleQr}
              >
                {isQrVisible ? 'Hide QR' : 'Show QR'}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              aria-label={`${device.nodeId ? 'Update' : 'Set up'} pairing for ${device.name}`}
              onClick={onOpenPairingDialog}
            >
              {device.nodeId ? 'Update pairing' : 'Set up pairing'}
            </Button>
          </div>
          {device.nodeId && isQrVisible && (
            <div id={pairingPanelId} className="flex justify-center pt-2 md:justify-start">
              <Suspense
                fallback={<p className="text-[length:var(--font-size-xs)] text-muted-foreground">Loading code…</p>}
              >
                <DeviceQrCode value={encodePairingTicket({ nodeId: device.nodeId, name: device.name })} />
              </Suspense>
            </div>
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
    <SettingsPageShell className="gap-6 md:pb-12">
      <PageHeader title="Devices" />

      {removeMutation.error && (
        <p className="text-sm text-destructive" role="alert">
          {removeMutation.error.message}
        </p>
      )}

      {hasPendingDevices && (
        <section className="flex flex-col gap-2">
          <SettingsSectionLabel>Pending approvals</SettingsSectionLabel>
          <ul className="flex flex-col gap-4">
            {pendingDevices.map((device) => (
              <li key={device.id}>
                <PendingDeviceRow
                  device={device}
                  isApprovePending={approveMutation.isPending}
                  isApprovingThisDevice={isMutatingDevice(approveMutation, device.id)}
                  isDenyPending={denyMutation.isPending}
                  isDenyingThisDevice={isMutatingDevice(denyMutation, device.id)}
                  onApprove={() => setConfirmationTarget({ action: 'approve', deviceId: device.id })}
                  onDeny={() => setConfirmationTarget({ action: 'deny', deviceId: device.id })}
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      {isLoading ? (
        <p className="text-muted-foreground py-4">Loading devices…</p>
      ) : visibleDevices.length === 0 ? (
        <p className="text-muted-foreground py-4">No devices yet. Sign in with sync to see devices here.</p>
      ) : (
        <section className="flex flex-col gap-2">
          {hasPendingDevices && <SettingsSectionLabel>Trusted devices</SettingsSectionLabel>}
          <ul className="flex flex-col gap-4">
            {visibleDevices.map((device) => (
              <li key={device.id}>
                <TrustedDeviceRow
                  device={device}
                  isCurrent={device.id === currentDeviceId}
                  isQrVisible={pairing.qrFor === device.id}
                  isRevokePending={revokeMutation.isPending}
                  isRevokingThisDevice={isMutatingDevice(revokeMutation, device.id)}
                  isRemovePending={removeMutation.isPending}
                  isRemovingThisDevice={isMutatingDevice(removeMutation, device.id)}
                  onRevoke={() => setConfirmationTarget({ action: 'revoke', deviceId: device.id })}
                  onRemove={() => setConfirmationTarget({ action: 'remove', deviceId: device.id })}
                  onToggleQr={() => pairing.toggleQr(device.id)}
                  onOpenPairingDialog={() => pairing.openDialog(device.id)}
                />
              </li>
            ))}
          </ul>
        </section>
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
