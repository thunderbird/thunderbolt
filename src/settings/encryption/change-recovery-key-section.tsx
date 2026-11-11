/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Button } from '@/components/ui/button'
import { RecoveryPhraseChangeDialogs } from '@/components/recovery-phrase-change-dialogs'
import { useDeviceKeyTrust } from '@/hooks/use-e2ee-ready'
import { useChangeRecoveryKey } from './use-change-recovery-key'

/**
 * "Change recovery phrase" row for the preferences Data section. Confirms,
 * emails a step-up code (THU-875 — the server refuses a recovery re-anchor
 * without it), then rotates the Account Key (0 rows re-encrypted), re-anchors
 * the recovery slot to a new phrase, and shows those 24 words exactly once
 * behind the saved-it confirmation gate. This is the only place outside
 * first-device setup and the v1→v2 migration that mints a phrase — device
 * revocation rotates silently. Hidden until E2EE v2 is fully set up on this
 * device — there is no key to rotate before then.
 */
export const ChangeRecoveryKeySection = () => {
  const { t } = useLingui()
  const { ready, unverified } = useDeviceKeyTrust()
  const flow = useChangeRecoveryKey()

  if (!ready) {
    return null
  }

  return (
    <>
      <div className="h-px bg-border -mx-6" />

      <div className="flex flex-col gap-2">
        <label htmlFor="change-recovery-key-button" className="text-sm font-medium">
          <Trans>Change Recovery Phrase</Trans>
        </label>
        <p className="text-sm text-muted-foreground">
          <Trans>
            Generate a new 24-word recovery phrase for your encrypted data. Your current phrase will stop working.
          </Trans>
        </p>
        {unverified && (
          <p id="change-recovery-key-blocked" className="text-sm text-muted-foreground">
            <Trans>
              This device can't change the recovery phrase because its encryption keys couldn't be verified. Change it
              from a device that was trusted before.
            </Trans>
          </p>
        )}
        <Button
          id="change-recovery-key-button"
          variant="secondary"
          onClick={flow.openConfirm}
          disabled={unverified}
          aria-describedby={unverified ? 'change-recovery-key-blocked' : undefined}
        >
          <Trans>Change Recovery Phrase</Trans>
        </Button>
      </div>

      <RecoveryPhraseChangeDialogs
        flow={flow}
        confirmTitle={t`Change your recovery phrase?`}
        confirmDescription={t`A new 24-word recovery phrase will be generated and shown to you once. Your current phrase will stop working immediately. Your synced data is unaffected. To continue, we’ll email you a verification code.`}
      />
    </>
  )
}
