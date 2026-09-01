/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { type KeyboardEvent } from 'react'

import { Button } from '@/components/ui/button'
import { Loader2 } from 'lucide-react'

type RecoveryKeyEntryStepProps = {
  value: string
  error: string | null
  onChange: (value: string) => void
  onSubmit: () => void
  isLoading?: boolean
}

export const RecoveryKeyEntryStep = ({ value, error, onChange, onSubmit, isLoading }: RecoveryKeyEntryStepProps) => {
  const { t } = useLingui()
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && e.metaKey && !isLoading) {
      onSubmit()
    }
  }

  const wordCount = value.trim() ? value.trim().split(/\s+/).length : 0

  return (
    <div className="w-full flex flex-col">
      <div className="text-center space-y-4">
        <h2 className="text-2xl font-bold">
          <Trans>Enter recovery phrase</Trans>
        </h2>
        <p className="text-muted-foreground">
          <Trans>Enter the 24-word recovery phrase you saved when you first set up sync.</Trans>
        </p>
      </div>

      <div className="pt-5 space-y-4">
        <div className="flex flex-col gap-2">
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t`word1 word2 word3 ...`}
            rows={4}
            className={`w-full rounded-lg border bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring ${
              error ? 'border-destructive' : 'border-input'
            }`}
            autoFocus
            disabled={isLoading}
            // The phrase is BIP-39 English whatever the UI language is, and
            // `useAppLanguage` now points `<html lang>` at the active locale — so
            // without these the browser applies German or Japanese autocorrect
            // (and, on mobile, autocapitalisation) to it. One mangled word costs
            // the user access to their encrypted data permanently, so nothing here
            // is allowed to be helpful.
            lang="en"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            autoComplete="off"
          />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>
              <Trans>{wordCount}/24 words</Trans>
            </span>
            {wordCount === 24 && (
              <span className="text-green-600">
                <Trans>Ready to submit</Trans>
              </span>
            )}
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <Button className="w-full" onClick={onSubmit} disabled={isLoading || wordCount !== 24}>
          {isLoading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              <Trans>Verifying…</Trans>
            </>
          ) : (
            <Trans>Submit</Trans>
          )}
        </Button>
      </div>
    </div>
  )
}
