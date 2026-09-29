/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { SettingsListBody, SettingsListPane, settingsListBodyRowsClass } from '@/components/settings/settings-list'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { PageCreateAction } from '@/components/ui/page-create-action'
import { PageHeader } from '@/components/ui/page-header'
import { StatusCard } from '@/components/ui/status-card'
import { useAuth } from '@/contexts'
import { useFormatters } from '@/i18n/use-formatters'
import { getDeviceDisplayName } from '@/lib/platform'
import {
  deletePasskey,
  isPasskeyCancellation,
  listPasskeys,
  registerPasskey,
  usePasskeyAvailable,
  type PasskeyRecord,
} from '@/lib/passkey'
import { Trans, useLingui } from '@lingui/react/macro'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Fingerprint, KeyRound, Plus, Trash2, X } from 'lucide-react'
import { useState } from 'react'

const passkeysQueryKey = ['passkeys'] as const

/** One registered passkey: leading icon, name + created date, trailing remove. */
const PasskeyRow = ({
  passkey,
  isDeleting,
  onDelete,
}: {
  passkey: PasskeyRecord
  isDeleting: boolean
  onDelete: () => void
}) => {
  const { t } = useLingui()
  const formatters = useFormatters()
  const name = passkey.name || t`Passkey`

  return (
    <Card className="flex-row items-center gap-3 border-border px-4 py-3">
      <Fingerprint className="size-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-base font-medium">{name}</p>
        <p className="truncate text-[length:var(--font-size-sm)] text-muted-foreground">
          <Trans>Added {formatters.date(passkey.createdAt)}</Trans>
        </p>
      </div>
      <Button
        variant="ghost"
        size="icon"
        aria-label={t`Remove ${name}`}
        onClick={onDelete}
        isLoading={isDeleting}
        className="shrink-0"
      >
        <Trash2 className="size-4" />
      </Button>
    </Card>
  )
}

/**
 * Passkeys settings page (THU-790 POC) — list, add, and remove sign-in passkeys.
 * Mirrors the Models page layout: `PageHeader` with an icon-only create action,
 * a `SettingsListBody` of rows, and a dashed empty state. The nav entry is hidden
 * when passkeys are unavailable or the session is anonymous; this page guards
 * those cases too for anyone who lands here by direct URL.
 */
export const PasskeysSettingsPage = () => {
  const { t } = useLingui()
  const authClient = useAuth()
  const queryClient = useQueryClient()
  const passkeyAvailable = usePasskeyAvailable()
  const { data: session } = authClient.useSession()
  const [errorMessage, setErrorMessage] = useState('')

  const isFullUser = !!session?.user && session.user.isAnonymous !== true
  const enabled = passkeyAvailable && isFullUser

  const { data: passkeys = [], isLoading } = useQuery({
    queryKey: passkeysQueryKey,
    queryFn: () => listPasskeys(authClient),
    enabled,
  })

  const addMutation = useMutation({
    // Match the synced-device naming ("Chrome on macOS", "Thunderbolt on iOS")
    // so a passkey is recognizable next to the user's devices.
    mutationFn: () => registerPasskey(authClient, getDeviceDisplayName()),
    onSuccess: () => {
      setErrorMessage('')
      queryClient.invalidateQueries({ queryKey: passkeysQueryKey })
    },
    onError: (error) => {
      if (isPasskeyCancellation(error)) {
        return
      }
      console.error('Passkey registration failed:', error)
      setErrorMessage(t`Couldn't add a passkey. Please try again.`)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deletePasskey(authClient, id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: passkeysQueryKey }),
    onError: (error) => {
      console.error('Passkey removal failed:', error)
      setErrorMessage(t`Couldn't remove the passkey. Please try again.`)
    },
  })

  const addPasskey = () => addMutation.mutate()

  return (
    <SettingsListPane className="gap-6 md:pb-12">
      <PageHeader title={t`Passkeys`}>
        {/* Hidden on the empty state, which carries its own add action (matches Projects). */}
        {enabled && passkeys.length > 0 && (
          <PageCreateAction label={t`Add passkey`} onClick={addPasskey} disabled={addMutation.isPending} />
        )}
      </PageHeader>

      {errorMessage && (
        <StatusCard
          icon={<X className="h-4 w-4 text-destructive" />}
          title={t`Something went wrong`}
          description={errorMessage}
        />
      )}

      {!enabled ? (
        <p className="py-4 text-muted-foreground">
          <Trans>Passkeys aren&apos;t available on this device.</Trans>
        </p>
      ) : isLoading ? (
        <p className="py-4 text-muted-foreground">
          <Trans>Loading passkeys…</Trans>
        </p>
      ) : (
        <SettingsListBody className={settingsListBodyRowsClass}>
          {passkeys.map((passkey) => (
            <PasskeyRow
              key={passkey.id}
              passkey={passkey}
              isDeleting={deleteMutation.isPending && deleteMutation.variables === passkey.id}
              onDelete={() => deleteMutation.mutate(passkey.id)}
            />
          ))}
          {passkeys.length === 0 && (
            <EmptyState
              icon={KeyRound}
              title={t`No passkeys yet`}
              description={t`Sign in with your fingerprint, face, or device PIN instead of an email code.`}
              action={
                <Button variant="outline" onClick={addPasskey} isLoading={addMutation.isPending} className="gap-2">
                  <Plus className="size-[var(--icon-size-sm)]" aria-hidden="true" />
                  <Trans>Add your first passkey</Trans>
                </Button>
              }
            />
          )}
        </SettingsListBody>
      )}
    </SettingsListPane>
  )
}

export default PasskeysSettingsPage
