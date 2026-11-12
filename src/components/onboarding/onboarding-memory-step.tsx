/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Brain } from 'lucide-react'
import { Trans, useLingui } from '@lingui/react/macro'
import { Switch } from '@/components/ui/switch'
import { OnboardingStepHeader } from './onboarding-step-header'

/** Consent is a draft until Continue, so mounting onboarding cannot enable recall. */
export const OnboardingMemoryStep = ({
  memory,
  history,
  onMemoryChange,
  onHistoryChange,
  disabled,
}: {
  memory: boolean
  history: boolean
  onMemoryChange: (enabled: boolean) => void
  onHistoryChange: (enabled: boolean) => void
  disabled: boolean
}) => {
  const { t } = useLingui()
  return (
    <div className="flex w-full flex-1 flex-col justify-center gap-8">
      <OnboardingStepHeader
        icon={<Brain className="size-10 text-primary" />}
        title={<Trans>A little continuity</Trans>}
        description={
          <Trans>
            Choose what your built-in agents can remember. You can change these choices anytime in Settings → Memory.
          </Trans>
        }
      />
      <div className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <label htmlFor="onboarding-memory" className="font-medium">
              <Trans>Saved memories</Trans>
            </label>
            <p className="mt-1 text-sm text-muted-foreground">
              <Trans>
                Keep short facts and preferences for future chats. You can review, edit, or clear them. Private chats
                cannot read or change built-in memory or connected memory services.
              </Trans>
            </p>
          </div>
          <Switch
            id="onboarding-memory"
            aria-label={t`Saved memories`}
            checked={memory}
            onCheckedChange={onMemoryChange}
            disabled={disabled}
          />
        </div>
        <div className="flex items-center justify-between gap-4">
          <div>
            <label htmlFor="onboarding-history" className="font-medium">
              <Trans>Reference earlier chats</Trans>
            </label>
            <p className="mt-1 text-sm text-muted-foreground">
              <Trans>
                Let agents search and read relevant parts of your other chats when useful. Private chats stay with
                confidential models.
              </Trans>
            </p>
          </div>
          <Switch
            id="onboarding-history"
            aria-label={t`Reference earlier chats`}
            checked={history}
            onCheckedChange={onHistoryChange}
            disabled={disabled}
          />
        </div>
      </div>
    </div>
  )
}
