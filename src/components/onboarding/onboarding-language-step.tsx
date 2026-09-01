/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useLanguageSetting } from '@/hooks/use-language-setting'
import { languageOptions } from '@/i18n/language-options'
import { useActiveLocale } from '@/i18n/use-active-locale'
import { Trans, useLingui } from '@lingui/react/macro'
import { Languages } from 'lucide-react'
import { OnboardingStepHeader } from './onboarding-step-header'

/**
 * Deliberately independent of the location step: the picker starts from the
 * browser-negotiated locale, not the country just chosen, so travelling or
 * living abroad doesn't quietly change the UI language.
 */
export const OnboardingLanguageStep = () => {
  const { t } = useLingui()
  const { setLanguage } = useLanguageSetting()
  // The store, not the raw setting: an unset `language` reads back as the
  // schema-defaulted `en`, which is indistinguishable from an explicit choice.
  const activeLanguage = useActiveLocale()

  return (
    <div className="flex w-full flex-1 flex-col justify-center">
      <OnboardingStepHeader
        icon={<Languages className="size-10 text-primary" />}
        title={<Trans>Which language do you prefer?</Trans>}
        description={<Trans>Thunderbolt will use it across the app. You can change it later in Preferences.</Trans>}
      />

      <div className="mt-10">
        <Select value={activeLanguage} onValueChange={setLanguage}>
          <SelectTrigger className="w-full" aria-label={t`Language`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {languageOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}
