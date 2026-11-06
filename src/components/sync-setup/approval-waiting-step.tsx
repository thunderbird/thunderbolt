/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useAppName } from '@/lib/branding-selectors'
import { Trans, useLingui } from '@lingui/react/macro'
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'
import { Button } from '@/components/ui/button'
import { Fingerprint, Loader2 } from 'lucide-react'
import { useState } from 'react'

type ApprovalWaitingStepProps = {
  fingerprint: string
  error: string | null
  onContinue: () => void
  onUseRecoveryKey: () => void
  /** Present when the account has a passkey slot this device can unlock with. */
  onUnlockWithPasskey?: () => void
  isLoading?: boolean
  isPolling?: boolean
}

export const ApprovalWaitingStep = ({
  fingerprint,
  error,
  onContinue,
  onUseRecoveryKey,
  onUnlockWithPasskey,
  isLoading,
  isPolling,
}: ApprovalWaitingStepProps) => {
  const appName = useAppName()
  const { t } = useLingui()
  const { copy, isCopied } = useCopyToClipboard()
  const [copyFailed, setCopyFailed] = useState(false)
  const copyFingerprint = async () => {
    try {
      await copy(fingerprint)
      setCopyFailed(false)
    } catch {
      setCopyFailed(true)
    }
  }

  return (
    <div className="w-full flex flex-col">
      <div className="text-center space-y-4">
        <h2 className="text-2xl font-bold">
          <Trans>Approve this device</Trans>
        </h2>
        <p className="text-muted-foreground">
          <Trans>
            Open {appName} on one of your trusted devices and go to Settings &rarr; Devices to approve this device.
          </Trans>
        </p>
        <p className="text-sm text-muted-foreground">
          <Trans>Enter this fingerprint on your trusted device before approving.</Trans>
        </p>
        <output aria-label={t`Device fingerprint`} className="block break-all font-mono select-all">
          {fingerprint}
        </output>
        <Button variant="outline" disabled={!fingerprint} onClick={copyFingerprint}>
          {isCopied ? <Trans>Copied</Trans> : <Trans>Copy fingerprint</Trans>}
        </Button>
        {copyFailed && (
          <p role="alert" className="text-sm text-destructive">
            <Trans>Couldn't copy. Select the fingerprint to copy it manually.</Trans>
          </p>
        )}
        {isPolling && (
          <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            <Trans>Checking automatically…</Trans>
          </p>
        )}
      </div>

      <div className="pt-5 space-y-4">
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <Button className="w-full" onClick={onContinue} disabled={isLoading}>
          {isLoading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              <Trans>Checking…</Trans>
            </>
          ) : (
            <Trans>Check now</Trans>
          )}
        </Button>

        {onUnlockWithPasskey && (
          <Button variant="outline" className="w-full" onClick={onUnlockWithPasskey} disabled={isLoading}>
            <Fingerprint className="mr-2 h-4 w-4" />
            <Trans>Unlock with passkey</Trans>
          </Button>
        )}

        <Button variant="ghost" className="w-full" onClick={onUseRecoveryKey} disabled={isLoading}>
          <Trans>Use my recovery key</Trans>
        </Button>
      </div>
    </div>
  )
}
