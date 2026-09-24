/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { useDatabase } from '@/contexts'
import { getAllDevices, getPendingDevices, type Device } from '@/dal'
import { getDeviceId } from '@/lib/auth-token'
import { PageHeader } from '@/components/ui/page-header'
import { ApproveDeviceDialog } from '@/components/approve-device-dialog'
import { RevokeDeviceDialog } from '@/components/revoke-device-dialog'
import { RemoveBridgeDialog } from '@/components/remove-bridge-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import type { Formatters } from '@/i18n/format'
import { useFormatters } from '@/i18n/use-formatters'
import { lazy, Suspense, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { useQuery } from '@powersync/tanstack-react-query'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useApproveDevice } from '@/hooks/use-approve-device'
import { useDenyDevice } from '@/hooks/use-deny-device'
import { useRefreshKeys, useRevokeDevice } from '@/hooks/use-revoke-device'
import { useFinishLockout, useLockoutPending } from '@/hooks/use-lockout-pending'
import { describeRevokeFailure } from '@/services/revoke-failure'
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

/** A revoked device lingers in the list for a day so the revocation is visible. */
const revokedDeviceVisibilityMs = 24 * 60 * 60 * 1000

const formatLastSeen = (formatters: Formatters, ts: string | null): string =>
  ts == null ? '—' : formatters.relativeTime(ts)

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
}: PendingDeviceRowProps) => {
  const { t } = useLingui()
  const deviceName = device.name

  return (
    <DeviceCard>
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{device.name}</p>
          <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
            <Trans>Waiting for approval</Trans>
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 md:flex md:shrink-0">
          <Button
            variant="outline"
            size="sm"
            aria-label={t`Deny ${deviceName}`}
            onClick={onDeny}
            disabled={isDenyPending}
            isLoading={isDenyingThisDevice}
            loadingLabel={t`Denying…`}
          >
            <Trans>Deny</Trans>
          </Button>
          <Button
            size="sm"
            aria-label={t`Approve ${deviceName}`}
            onClick={onApprove}
            disabled={isApprovePending}
            isLoading={isApprovingThisDevice}
            loadingLabel={t`Approving…`}
          >
            <Trans>Approve</Trans>
          </Button>
        </div>
      </div>
    </DeviceCard>
  )
}

type TrustedDeviceRowProps = {
  device: Device
  isCurrent: boolean
  isQrVisible: boolean
  isRevokePending: boolean
  isRevokingThisDevice: boolean
  isRemovePending: boolean
  isRemovingThisDevice: boolean
  /** Revoked, but the AK rotation that locks it out never landed (THU-887). */
  isAwaitingLockout: boolean
  isFinishingLockout: boolean
  onRevoke: () => void
  onRemove: () => void
  onFinishLockout: () => void
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
  isAwaitingLockout,
  isFinishingLockout,
  onRevoke,
  onRemove,
  onFinishLockout,
  onToggleQr,
  onOpenPairingDialog,
}: TrustedDeviceRowProps) => {
  const { t } = useLingui()
  const formatters = useFormatters()
  const deviceName = device.name
  const lastSeen = formatLastSeen(formatters, device.lastSeen)
  const isRevoked = device.revokedAt != null
  const isBridge = device.deviceType === 'bridge'
  const isCli = device.deviceType === 'cli'
  const supportsPairing = device.deviceType === null || device.deviceType === 'normal' || isBridge
  const pairingPanelId = `device-pairing-${device.id}`
  return (
    <DeviceCard>
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 truncate font-medium">{device.name}</p>
            {isBridge && (
              <DeviceBadge>
                <Trans>Bridge</Trans>
              </DeviceBadge>
            )}
            {isCli && (
              <DeviceBadge>
                <Trans>CLI</Trans>
              </DeviceBadge>
            )}
            {isCli && !isRevoked && (
              <DeviceBadge>
                <Trans>Active</Trans>
              </DeviceBadge>
            )}
            {isCurrent && (
              <DeviceBadge>
                <Trans>This device</Trans>
              </DeviceBadge>
            )}
            {isRevoked && (
              <DeviceBadge>
                <Trans>Revoked</Trans>
              </DeviceBadge>
            )}
          </div>
          <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
            {isRevoked && isBridge
              ? t`No longer accepts device connections`
              : isBridge
                ? t`Accepts connections from your devices`
                : t`Last seen ${lastSeen}`}
          </p>
        </div>
        <div className="grid grid-cols-1 md:shrink-0">
          {!isRevoked && !isCurrent && (
            <Button
              variant="outline"
              size="sm"
              aria-label={t`Revoke ${deviceName}`}
              onClick={onRevoke}
              disabled={isRevokePending}
              isLoading={isRevokingThisDevice}
              loadingLabel={t`Revoking…`}
            >
              <Trans>Revoke</Trans>
            </Button>
          )}
          {isRevoked && isBridge && (
            <Button
              variant="outline"
              size="sm"
              onClick={onRemove}
              disabled={isRemovePending}
              isLoading={isRemovingThisDevice}
              loadingLabel={t`Removing…`}
            >
              <Trans>Remove</Trans>
            </Button>
          )}
        </div>
      </div>

      {/*
        Revoked, but the rotation that makes its account key worthless never
        landed (THU-887). The "Revoked" badge above is, on its own, the lie this
        ticket is about — so say what is still true and offer the one action that
        fixes it. Every device on the account sees this, because the server
        derives it rather than the client that failed remembering it.
      */}
      {isAwaitingLockout && (
        <div className="mt-3 flex flex-col gap-2 border-t pt-3">
          <p className="text-[length:var(--font-size-sm)] text-destructive" role="alert">
            <Trans>
              This device lost access, but your account key was not replaced — so it can still read data it already has,
              and anything written since. Finish securing your account to lock it out.
            </Trans>
          </p>
          <div className="grid grid-cols-1 md:flex md:justify-end">
            <Button
              variant="outline"
              size="sm"
              aria-label={t`Finish securing after revoking ${deviceName}`}
              onClick={onFinishLockout}
              disabled={isFinishingLockout}
              isLoading={isFinishingLockout}
              loadingLabel={t`Securing…`}
            >
              <Trans>Finish securing</Trans>
            </Button>
          </div>
        </div>
      )}

      {!isRevoked && supportsPairing && (
        <div className="mt-3 flex flex-col gap-2 border-t pt-3">
          <p className="text-[length:var(--font-size-xs)] font-medium uppercase tracking-wide text-muted-foreground">
            <Trans>Pairing identity</Trans>
          </p>
          <p className="break-all font-mono text-[length:var(--font-size-xs)] text-muted-foreground">
            {device.nodeId ?? t`Not configured`}
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:flex md:justify-end">
            {device.nodeId && (
              <Button
                variant="outline"
                size="sm"
                aria-label={isQrVisible ? t`Hide QR code for ${deviceName}` : t`Show QR code for ${deviceName}`}
                aria-expanded={isQrVisible}
                aria-controls={pairingPanelId}
                onClick={onToggleQr}
              >
                {isQrVisible ? <Trans>Hide QR</Trans> : <Trans>Show QR</Trans>}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              aria-label={device.nodeId ? t`Update pairing for ${deviceName}` : t`Set up pairing for ${deviceName}`}
              onClick={onOpenPairingDialog}
            >
              {device.nodeId ? <Trans>Update pairing</Trans> : <Trans>Set up pairing</Trans>}
            </Button>
          </div>
          {device.nodeId && isQrVisible && (
            <div id={pairingPanelId} className="flex justify-center pt-2 md:justify-start">
              <Suspense
                fallback={
                  <p className="text-[length:var(--font-size-xs)] text-muted-foreground">
                    <Trans>Loading code…</Trans>
                  </p>
                }
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
  const { i18n, t } = useLingui()
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

  const awaitingLockout = useLockoutPending()
  const finishLockoutMutation = useFinishLockout()

  const visibleDevices = devices.filter((d) => {
    if (d.revokedAt != null) {
      // The visibility window is cosmetic tidying, and it used to dispose of the
      // evidence: a device whose lockout rotation never landed still holds a
      // usable account key, so hiding it would hide the one thing the user needs
      // to act on (THU-887). It stays until the rotation actually happens.
      return awaitingLockout.has(d.id) || Date.now() - new Date(d.revokedAt).getTime() < revokedDeviceVisibilityMs
    }
    return !!d.trusted
  })

  const revokeMutation = useRevokeDevice()
  const refreshKeysMutation = useRefreshKeys()
  const removeMutation = useRemoveDevice()
  const denyMutation = useDenyDevice()
  const approveMutation = useApproveDevice(pendingDevices)
  const setNodeIdMutation = useSetDeviceNodeId()
  const pairing = useDevicePairing()

  const dialogDevice = devices.find((d) => d.id === pairing.dialogFor) ?? null
  const revokeDevice =
    confirmationTarget?.action === 'revoke'
      ? devices.find((device) => device.id === confirmationTarget.deviceId)
      : undefined
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

  /**
   * The revoke failure, scoped to the device the dialog is currently about.
   * Scoping by `variables` rather than resetting the mutation on open gets the
   * same staleness protection per-device instead of globally, and also covers
   * dismissing the dialog mid-flight — where a reset-on-open would have dropped
   * the failure that arrived afterwards.
   */
  const revokeFailure =
    revokeMutation.error && revokeMutation.variables === confirmationTarget?.deviceId
      ? describeRevokeFailure(revokeMutation.error)
      : null

  return (
    <SettingsPageShell className="gap-6 md:pb-12">
      <PageHeader title={t`Devices`} />

      {removeMutation.error && (
        <p className="text-sm text-destructive" role="alert">
          {removeMutation.error.message}
        </p>
      )}

      {/* The lockout retry has no dialog of its own, so its failure surfaces here. */}
      {finishLockoutMutation.error && (
        <p className="text-sm text-destructive" role="alert">
          {i18n._(describeRevokeFailure(finishLockoutMutation.error).message)}
        </p>
      )}

      {approveMutation.error && (
        <p className="text-sm text-destructive" role="alert">
          {approveMutation.error.message}
        </p>
      )}

      {hasPendingDevices && (
        <section className="flex flex-col gap-2">
          <SettingsSectionLabel>
            <Trans>Pending approvals</Trans>
          </SettingsSectionLabel>
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
        <p className="text-muted-foreground py-4">
          <Trans>Loading devices…</Trans>
        </p>
      ) : visibleDevices.length === 0 ? (
        <p className="text-muted-foreground py-4">
          <Trans>No devices yet. Sign in with sync to see devices here.</Trans>
        </p>
      ) : (
        <section className="flex flex-col gap-2">
          {hasPendingDevices && (
            <SettingsSectionLabel>
              <Trans>Trusted devices</Trans>
            </SettingsSectionLabel>
          )}
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
                  isAwaitingLockout={awaitingLockout.has(device.id)}
                  isFinishingLockout={finishLockoutMutation.isPending}
                  onRevoke={() => setConfirmationTarget({ action: 'revoke', deviceId: device.id })}
                  onRemove={() => setConfirmationTarget({ action: 'remove', deviceId: device.id })}
                  onFinishLockout={() => finishLockoutMutation.mutate()}
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
        variant={revokeDevice?.deviceType === 'cli' ? 'cli' : 'trusted'}
        error={revokeFailure && i18n._(revokeFailure.message)}
        errorAction={
          revokeFailure?.action === 'refreshKeys' ? (
            // The revoke NEVER refreshes keys as a silent side effect (THU-872)
            // — adopting a server-supplied account key inside an emergency cut
            // is exactly the dependency THU-887 removed. One explicit action:
            // refresh (witness-gated), then retry the same revoke.
            <div className="flex flex-col gap-1">
              <Button
                variant="outline"
                size="sm"
                isLoading={refreshKeysMutation.isPending}
                loadingLabel={t`Refreshing keys…`}
                onClick={() =>
                  refreshKeysMutation.mutate(undefined, {
                    onSuccess: () => confirmPendingAction('revoke', revokeMutation),
                  })
                }
              >
                <Trans>Refresh keys and retry</Trans>
              </Button>
              {refreshKeysMutation.error && (
                <p className="text-[length:var(--font-size-xs)] text-destructive" role="alert">
                  {refreshKeysMutation.error.message}
                </p>
              )}
              <p className="text-[length:var(--font-size-xs)] text-muted-foreground">
                <Trans>
                  Another device changed the account keys. Refreshing fetches the current key, then the revoke runs
                  again.
                </Trans>
              </p>
            </div>
          ) : revokeFailure?.action === 'phraseChange' ? (
            // A link, not a sentence: the section lives in Settings →
            // Preferences → Data, so naming it in prose leaves the user to find
            // it. The cost is stated because it is irreversible — the phrase
            // they hold today stops working.
            <div className="flex flex-col gap-1">
              <Button variant="outline" size="sm" asChild>
                <Link to="/settings/preferences">
                  <Trans>Change recovery phrase</Trans>
                </Link>
              </Button>
              <p className="text-[length:var(--font-size-xs)] text-muted-foreground">
                <Trans>
                  This replaces your 24-word phrase. The one you have now will stop working, and you will need to save
                  the new one.
                </Trans>
              </p>
            </div>
          ) : null
        }
      />

      <RevokeDeviceDialog
        open={confirmationTarget?.action === 'deny'}
        onOpenChange={(open) => !open && setConfirmationTarget(null)}
        onConfirm={() => confirmPendingAction('deny', denyMutation)}
        isPending={denyMutation.isPending}
        variant="pending"
        error={
          denyMutation.error && denyMutation.variables === confirmationTarget?.deviceId
            ? denyMutation.error.message
            : null
        }
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
