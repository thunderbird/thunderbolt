/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { onlineManager, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLingui } from '@lingui/react/macro'
import type { EncryptionMetadataResponse } from '@shared/e2ee-types'
import { fetchEncryptionMetadataOrNull, postStepUpRequest } from '@/api/encryption'
import { RecoveryPhraseChangeDialogs } from '@/components/recovery-phrase-change-dialogs'
import { useAuth, useHttpClient, type HttpClient } from '@/contexts'
import { readDeviceKeyTrust, useDeviceKeyTrust } from '@/hooks/use-e2ee-ready'
import { recoveryPhraseChangedEvent } from '@/lib/recovery-phrase-pending'
import { changeRecoveryPhrase, migratePasskeyContinuity } from '@/services/encryption'
import { useChangeRecoveryKey } from '@/settings/encryption/use-change-recovery-key'
import { usePasskeyContinuityMigration } from '@/settings/encryption/use-passkey-continuity-migration'
import { getLocalSetting, useLocalSettingsStore } from '@/stores/local-settings-store'
import {
  accountNeedsContinuityUpdate,
  derivePasskeyContinuityStatus,
  deriveRecoveryContinuityStatus,
  nextUpdateRequiredCache,
  passkeyNeedsContinuityUpdate,
  phraseUpdateRequired,
  type DeviceKeyTrust,
  type PasskeyContinuityStatus,
  type RecoveryContinuityStatus,
} from './recovery-continuity-status'

/** Session-only outcomes the banner and the card announce. */
export type RecoveryContinuityNotice = 'none' | 'updatedHere' | 'updatedElsewhere' | 'passkeyUpdated'

export type RecoveryContinuityContextValue = {
  status: RecoveryContinuityStatus
  /** The account's phrase has no seal, whatever this device's trust (for the card's phrase fact). */
  phraseUpdateRequired: boolean
  passkey: PasskeyContinuityStatus
  notice: RecoveryContinuityNotice
  /** Holds usable keys and is not marked unverified. */
  deviceTrusted: boolean
  passkeyMigration: { busy: boolean; errorMessage: string | null }
  start: () => Promise<void>
  startPasskeyMigration: () => Promise<void>
  dismissNotice: () => void
}

export const recoveryContinuityQueryKey = (userId: string) => ['recovery-continuity', userId] as const

const idle = async () => {}

export const RecoveryContinuityContext = createContext<RecoveryContinuityContextValue>({
  status: 'hidden',
  phraseUpdateRequired: false,
  passkey: 'none',
  notice: 'none',
  deviceTrusted: false,
  passkeyMigration: { busy: false, errorMessage: null },
  start: idle,
  startPasskeyMigration: idle,
  dismissNotice: () => {},
})

const subscribeOnline = (onChange: () => void) => onlineManager.subscribe(onChange)
const readOnline = () => onlineManager.isOnline()

type RecoveryContinuityProviderProps = {
  children: ReactNode
  rotate?: (httpClient: HttpClient, opts: { stepUpOtp: string }) => Promise<string>
  requestCode?: (httpClient: HttpClient) => Promise<void>
  readTrust?: () => Promise<DeviceKeyTrust>
  migratePasskey?: typeof migratePasskeyContinuity
  readPrf?: (credentialId: string) => Promise<Uint8Array | null>
}

/**
 * Owns the continuity status that the banner, the Settings marker and the
 * Preferences card read: one metadata query, this device's key trust, both
 * migrations, and the session's notices. Also renders the phrase-change
 * dialogs, so the banner and the card can start the flow from any route.
 *
 * The status reflects what the server reports. A malicious server can hide a
 * needed update; this is a migration aid, and the protection itself comes from
 * the seal a trusted device mints.
 */
export const RecoveryContinuityProvider = ({
  children,
  rotate = changeRecoveryPhrase,
  requestCode = postStepUpRequest,
  readTrust = readDeviceKeyTrust,
  migratePasskey = migratePasskeyContinuity,
  readPrf,
}: RecoveryContinuityProviderProps) => {
  const { t } = useLingui()
  const httpClient = useHttpClient()
  const queryClient = useQueryClient()
  const { data: session } = useAuth().useSession()
  const userId = session?.user && !session.user.isAnonymous ? session.user.id : null
  const trust = useDeviceKeyTrust(readTrust)
  const isOnline = useSyncExternalStore(subscribeOnline, readOnline)
  const cachedUpdateRequiredFor = useLocalSettingsStore((state) => state.recoveryContinuityUpdateRequiredFor)
  const [notice, setNotice] = useState<RecoveryContinuityNotice>('none')
  // A seal that appears after a phrase change committed here is ours, not another device's.
  const changedHere = useRef(false)
  const queryKey = recoveryContinuityQueryKey(userId ?? '')

  const fetchStatus = async (): Promise<EncryptionMetadataResponse | null> => {
    const metadata = await fetchEncryptionMetadataOrNull(httpClient)
    if (!userId) {
      return metadata
    }
    const cachedBefore = getLocalSetting('recoveryContinuityUpdateRequiredFor')
    const previous = queryClient.getQueryData<EncryptionMetadataResponse | null>(queryKey)
    if (phraseUpdateRequired(previous, cachedBefore, userId) && metadata?.recovery_continuity != null) {
      setNotice(changedHere.current ? 'updatedHere' : 'updatedElsewhere')
    }
    useLocalSettingsStore
      .getState()
      .setLocalSetting('recoveryContinuityUpdateRequiredFor', nextUpdateRequiredCache(cachedBefore, userId, metadata))
    return metadata
  }

  const query = useQuery({
    queryKey,
    queryFn: fetchStatus,
    enabled: userId !== null,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchInterval: 600_000,
    retry: false,
  })

  const refetchStatus = () => queryClient.fetchQuery({ queryKey, queryFn: fetchStatus, staleTime: 0 })

  // Runs right before rotating, after the user has read the emailed code. By then
  // another device may have sealed the phrase, or this device may have lost trust.
  const canRotate = async () => {
    const metadata = await refetchStatus()
    const current = await readTrust()
    return accountNeedsContinuityUpdate(metadata) && current.ready && !current.unverified
  }

  const flow = useChangeRecoveryKey(rotate, requestCode, canRotate)
  const passkeyMigration = usePasskeyContinuityMigration(migratePasskey, readPrf)

  // Legitimate useEffect: a DOM event subscription with cleanup.
  useEffect(() => {
    const onPhraseChanged = () => {
      changedHere.current = true
      setNotice('updatedHere')
      void queryClient.invalidateQueries({ queryKey: ['recovery-continuity'] })
    }
    window.addEventListener(recoveryPhraseChangedEvent, onPhraseChanged)
    return () => window.removeEventListener(recoveryPhraseChangedEvent, onPhraseChanged)
  }, [queryClient])

  const inputs = { userId, trust, isOnline, metadata: query.data, cachedUpdateRequiredFor }
  const status = deriveRecoveryContinuityStatus(inputs)
  const passkey = derivePasskeyContinuityStatus(inputs)

  const start = async () => {
    if (status !== 'warning') {
      return
    }
    // A failed re-check still opens the dialog; the guard re-checks before rotating.
    const metadata = await refetchStatus().catch(() => undefined)
    if (metadata !== undefined && !accountNeedsContinuityUpdate(metadata)) {
      return
    }
    flow.openConfirm()
  }

  const startPasskeyMigration = async () => {
    if (passkey !== 'needsUpdate') {
      return
    }
    const outcome = await passkeyMigration.run(async () => {
      const metadata = await refetchStatus()
      return metadata?.passkey_credential_id && passkeyNeedsContinuityUpdate(metadata)
        ? metadata.passkey_credential_id
        : null
    })
    if (outcome === 'sealed') {
      setNotice('passkeyUpdated')
      void queryClient.invalidateQueries({ queryKey })
    }
  }

  const value: RecoveryContinuityContextValue = {
    status,
    phraseUpdateRequired: phraseUpdateRequired(query.data, cachedUpdateRequiredFor, userId),
    passkey,
    notice,
    deviceTrusted: trust.ready && !trust.unverified,
    passkeyMigration: { busy: passkeyMigration.busy, errorMessage: passkeyMigration.errorMessage },
    start,
    startPasskeyMigration,
    dismissNotice: () => setNotice('none'),
  }

  return (
    <RecoveryContinuityContext.Provider value={value}>
      {children}
      <RecoveryPhraseChangeDialogs
        flow={flow}
        confirmTitle={t`Update your recovery phrase?`}
        confirmDescription={t`You'll get a new 24-word recovery phrase, shown once. It lets recovery confirm that your encryption keys are really yours. Your current phrase stops working as soon as the new one is created, and your synced data is unaffected. To continue, we'll email you a verification code.`}
      />
    </RecoveryContinuityContext.Provider>
  )
}

export const useRecoveryContinuity = (): RecoveryContinuityContextValue => useContext(RecoveryContinuityContext)
