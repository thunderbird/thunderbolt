/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { clearRecoveryPhrasePending } from '@/lib/recovery-phrase-pending'
import { Check, Copy } from 'lucide-react'
import { useState } from 'react'

type RecoveryKeyDisplayStepProps = {
  recoveryKey: string
  onDone: () => void
  onConfirmedChange?: (confirmed: boolean) => void
  /** Contextual heading (defaults to the first-device setup copy). */
  title?: string
  /** Contextual explanation (defaults to the first-device setup copy). */
  description?: string
}

export const RecoveryKeyDisplayStep = ({
  recoveryKey,
  onDone,
  onConfirmedChange,
  title,
  description,
}: RecoveryKeyDisplayStepProps) => {
  const { t } = useLingui()
  // Defaults are the first-device setup copy, translated; callers pass contextual
  // overrides (migration, change-phrase) as already-localized strings.
  const heading = title ?? t`Save your recovery phrase`
  const explanation =
    description ??
    t`Write down these 24 words in order and store them somewhere safe. You'll need them to recover your data if you lose access to all your devices. This phrase won't be shown again.`
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [confirmed, setConfirmed] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(recoveryKey)
      setCopyState('copied')
      setTimeout(() => setCopyState('idle'), 2000)
    } catch {
      setCopyState('failed')
    }
  }

  const handleConfirmedChange = (checked: boolean) => {
    setConfirmed(checked)
    onConfirmedChange?.(checked)
  }

  return (
    <div className="w-full flex flex-col">
      <div className="text-center space-y-4">
        <h2 className="text-2xl font-bold">{heading}</h2>
        <p className="text-muted-foreground">{explanation}</p>
      </div>

      <div className="pt-5 space-y-4">
        <div role="region" aria-label={t`Recovery phrase`} className="rounded-xl bg-muted p-4">
          <p className="text-sm font-medium leading-relaxed">{recoveryKey}</p>
        </div>

        <Button variant="outline" className="w-full" onClick={handleCopy}>
          {copyState === 'copied' ? (
            <>
              <Check className="size-4 mr-2" />
              <Trans>Copied</Trans>
            </>
          ) : (
            <>
              <Copy className="size-4 mr-2" />
              <Trans>Copy to clipboard</Trans>
            </>
          )}
        </Button>

        {copyState === 'failed' && (
          <p className="text-sm text-destructive text-center">
            <Trans>Clipboard unavailable. Please select the phrase above and copy it manually.</Trans>
          </p>
        )}

        <label className="flex items-start gap-3 cursor-pointer">
          <Checkbox checked={confirmed} onCheckedChange={(v) => handleConfirmedChange(v === true)} className="mt-0.5" />
          <span className="text-sm">
            <Trans>I have saved my recovery phrase</Trans>
          </span>
        </label>

        <Button
          className="w-full"
          onClick={() => {
            try {
              navigator.clipboard.writeText('')
            } catch {
              // Best-effort clipboard clear
            }
            // The single choke point for "the user acknowledged saving a phrase" —
            // every surface that displays one (setup wizard, migration, revoke
            // rotation, change-phrase) renders this step, so clearing here can
            // never be forgotten by a caller.
            clearRecoveryPhrasePending()
            onDone()
          }}
          disabled={!confirmed}
        >
          <Trans>Done</Trans>
        </Button>
      </div>
    </div>
  )
}
