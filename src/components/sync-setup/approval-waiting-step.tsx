/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useAppName } from '@/lib/branding-selectors'
import { Trans, useLingui } from '@lingui/react/macro'
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Fingerprint, Loader2, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { type ApprovalCodeSessionStatus, useApprovalCodeSession } from './use-approval-code-session'

type ApprovalWaitingStepProps = {
  fingerprint: string
  error: string | null
  onContinue: () => void
  onUseRecoveryKey: () => void
  /** Present when the account has a passkey slot this device can unlock with. */
  onUnlockWithPasskey?: () => void
  isLoading?: boolean
  /** Injected in tests; production builds the approval-code context from this device's local keys. */
  getApprovalCodeContext?: (sessionId: string) => Promise<string>
}

/**
 * The new device waits for a trusted one. Approval is detected automatically, so the screen has no
 * primary action. The code is what the user compares; the other ways to unlock stay secondary.
 */
export const ApprovalWaitingStep = ({
  fingerprint,
  error,
  onContinue,
  onUseRecoveryKey,
  onUnlockWithPasskey,
  isLoading,
  getApprovalCodeContext,
}: ApprovalWaitingStepProps) => {
  const appName = useAppName()
  const codeSession = useApprovalCodeSession({ getContext: getApprovalCodeContext })
  const [fingerprintChosen, setFingerprintChosen] = useState(false)
  // An older backend (or no local keys) cannot run the code, so the fingerprint is the only path.
  const codeAvailable = codeSession.status !== 'unavailable'

  return (
    <div className="flex w-full flex-col gap-6">
      <div className="space-y-2 text-center">
        <h2 className="text-2xl font-bold">
          <Trans>Approve this device</Trans>
        </h2>
        <p className="text-balance text-muted-foreground">
          <Trans>Open {appName} on a trusted device and approve this one in Settings &rarr; Devices.</Trans>
        </p>
      </div>

      <div className="space-y-2">
        {codeSession.status === 'unavailable' || fingerprintChosen ? (
          <FingerprintPanel fingerprint={fingerprint} />
        ) : (
          <ApprovalCodePanel status={codeSession.status} code={codeSession.code} onNewCode={codeSession.newCode} />
        )}
        {codeAvailable && (
          <div className="flex justify-center">
            <Button variant="link" size="sm" onClick={() => setFingerprintChosen(!fingerprintChosen)}>
              {fingerprintChosen ? <Trans>Use code instead</Trans> : <Trans>Use fingerprint instead</Trans>}
            </Button>
          </div>
        )}
      </div>

      {/* The automatic check needs no button; a manual retry is offered only once a check has failed. */}
      {error && (
        <div className="space-y-3">
          <p role="alert" className="text-center text-sm text-destructive">
            {error}
          </p>
          <Button variant="outline" className="w-full" onClick={onContinue} disabled={isLoading}>
            {isLoading ? (
              <>
                <Loader2 className="animate-spin" />
                <Trans>Checking…</Trans>
              </>
            ) : (
              <Trans>Check now</Trans>
            )}
          </Button>
        </div>
      )}

      <div className="flex flex-col gap-1">
        {onUnlockWithPasskey && (
          <Button variant="ghost" className="w-full" onClick={onUnlockWithPasskey} disabled={isLoading}>
            <Fingerprint />
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

type ApprovalCodePanelProps = {
  status: Exclude<ApprovalCodeSessionStatus, 'unavailable'>
  code: string | null
  onNewCode: () => void
}

/** What the panel says under the code (or its placeholder) in each state. */
const PanelCaption = ({ status }: { status: ApprovalCodePanelProps['status'] }) => {
  switch (status) {
    case 'showing':
      return <Trans>Pick this code on your other device.</Trans>
    case 'expired':
      return <Trans>This code expired.</Trans>
    case 'failed':
      return <Trans>Couldn't get a code.</Trans>
    case 'starting':
    case 'waiting':
      return <Trans>Waiting for your other device…</Trans>
  }
}

/** Same anatomy in every state (value line, then caption) at a fixed minimum height, so nothing jumps. */
const ApprovalCodePanel = ({ status, code, onNewCode }: ApprovalCodePanelProps) => {
  const { t } = useLingui()
  const showing = status === 'showing' && code !== null
  // A code that ended (expired, or never started) gets a new one; one on its way only pulses.
  const ended = status === 'expired' || status === 'failed'
  return (
    <div className="flex min-h-44 flex-col items-center justify-center gap-2 rounded-xl border bg-secondary/50 px-4 py-4">
      {showing ? (
        <output
          aria-label={t`Approval code`}
          className="block h-16 text-6xl leading-none font-semibold tabular-nums tracking-wide"
        >
          {code}
        </output>
      ) : (
        <div className="flex h-16 items-center" aria-hidden>
          <span className={cn('h-14 w-20 rounded-lg bg-muted-foreground/15', !ended && 'motion-safe:animate-pulse')} />
        </div>
      )}
      <p role="status" className="text-center text-[length:var(--font-size-sm)] text-muted-foreground">
        <PanelCaption status={showing ? 'showing' : status} />
      </p>
      {(showing || ended) && (
        <Button variant="ghost" size="sm" onClick={onNewCode}>
          <RefreshCw />
          <Trans>New code</Trans>
        </Button>
      )}
    </div>
  )
}

/** The device fingerprint: the path for older trusted devices and after too many missed codes. */
const FingerprintPanel = ({ fingerprint }: { fingerprint: string }) => {
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
    <div className="flex flex-col items-center gap-3 rounded-xl border bg-secondary/50 px-4 pt-5 pb-3 text-center">
      <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
        <Trans>Enter this fingerprint on your trusted device before approving.</Trans>
      </p>
      <output aria-label={t`Device fingerprint`} className="block font-mono break-words select-all">
        {fingerprint}
      </output>
      <Button variant="ghost" size="sm" disabled={!fingerprint} onClick={copyFingerprint}>
        {isCopied ? <Trans>Copied</Trans> : <Trans>Copy fingerprint</Trans>}
      </Button>
      {copyFailed && (
        <p role="alert" className="text-sm text-destructive">
          <Trans>Couldn't copy. Select the fingerprint to copy it manually.</Trans>
        </p>
      )}
    </div>
  )
}
