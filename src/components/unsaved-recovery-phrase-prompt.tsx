/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { RecoveryKeyDialog } from '@/components/recovery-key-dialog'
import { setSyncEnabled } from '@/db/powersync/sync-state'
import { StepUpCodeDialog } from '@/components/step-up-code-dialog'
import { useRecoveryPhrasePending } from '@/lib/recovery-phrase-pending'
import { useChangeRecoveryKey } from '@/settings/encryption/use-change-recovery-key'

/**
 * Re-prompt for an account whose recovery phrase was minted but never
 * acknowledged — the app was reloaded, crashed or force-quit while the phrase
 * was on screen, or (before this existed) the migration dialog was suppressed.
 *
 * The original phrase cannot be re-shown: `AK = PBKDF2(seed, salt)` is one-way
 * and the seed was never persisted. So the only honest remedy is to mint a fresh
 * one, which is exactly what the existing "Change recovery phrase" rotation
 * does — reused here rather than duplicated.
 *
 * Dismissible per session (the user may be mid-task and their data is safe while
 * this device holds its keys), but the flag survives, so it returns on the next
 * launch until a phrase is actually confirmed.
 */
export const UnsavedRecoveryPhrasePrompt = () => {
  const { t } = useLingui()
  const pending = useRecoveryPhrasePending()
  const [dismissed, setDismissed] = useState(false)
  const { status, newRecoveryKey, isBusy, otp, error, setOtp, requestStepUpCode, confirmRotation, cancel, done } =
    useChangeRecoveryKey()

  /**
   * Snapshot at mount, so this only ever speaks for a phrase left unacknowledged
   * by an EARLIER session.
   *
   * Reacting to the live flag was wrong: it is set the moment a phrase is minted,
   * which is precisely when some other surface (the setup wizard, the migration
   * dialog) is displaying that phrase — so the prompt appeared on top of the very
   * dialog the user was reading, claiming the phrase was never saved.
   */
  const [wasPendingAtStartup] = useState(pending)

  /**
   * Finishing here also finishes the SETUP this prompt exists because of.
   *
   * Sync is switched on by the wizard's completion callback, not by setup
   * succeeding — so a tab closed on the phrase screen leaves the keys written,
   * `recoveryPhrasePending` set, and sync silently off. That screen is the one
   * that asks the user to go and write 24 words down somewhere, which makes it
   * the likeliest place in the whole flow for the page to go away.
   *
   * Without this the next launch tells them "Encryption is set up on this
   * device" — true — while nothing is syncing and nothing says so.
   */
  const handleDone = async () => {
    await setSyncEnabled(true)
    done()
  }

  if ((!wasPendingAtStartup || !pending) && status !== 'display' && status !== 'stepUp') {
    return null
  }

  return (
    <>
      <AlertDialog open={wasPendingAtStartup && pending && !dismissed && status !== 'display' && status !== 'stepUp'}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Your recovery phrase was never saved</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>
                Encryption is set up on this device, but the 24-word recovery phrase was not confirmed. Without it you
                cannot recover your data if you lose access to this device. The previous phrase cannot be shown again —
                generate a new one now.
              </Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <p className="text-[length:var(--font-size-sm)] text-destructive" role="alert">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <Button variant="ghost" onClick={() => setDismissed(true)} disabled={isBusy}>
              <Trans>Later</Trans>
            </Button>
            {/* Phrase changes are step-up-gated (THU-875): email a code first,
                then StepUpCodeDialog below runs the gated rotation. */}
            <AlertDialogAction onClick={requestStepUpCode} disabled={isBusy}>
              {isBusy ? t`Sending code…` : t`Generate a new phrase`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <StepUpCodeDialog
        open={status === 'stepUp'}
        otp={otp}
        isBusy={isBusy}
        error={error}
        description={t`We sent an 8-digit code to your account email. Enter it to generate your new recovery phrase.`}
        submitLabel={t`Generate new phrase`}
        submitLoadingLabel={t`Generating…`}
        submitOnComplete
        onOtpChange={setOtp}
        onResend={requestStepUpCode}
        onSubmit={confirmRotation}
        onCancel={cancel}
      />

      <RecoveryKeyDialog
        open={status === 'display'}
        recoveryKey={newRecoveryKey ?? ''}
        title={t`Save your new recovery phrase`}
        description={t`Write down these 24 words in order and store them somewhere safe. This phrase won't be shown again.`}
        onDone={handleDone}
      />
    </>
  )
}
