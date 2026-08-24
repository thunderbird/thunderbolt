/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useSettings } from '@/hooks/use-settings'
import { languageOptions } from '@/i18n/language-options'
import { sourceLocale } from '@shared/i18n/locales'
import { getBrowserLanguages, resolveLocale } from '@/i18n/resolve-locale'
import { Languages } from 'lucide-react'
import { OnboardingStepHeader } from './onboarding-step-header'

/**
 * Deliberately independent of the location step: the picker starts from the
 * browser-negotiated locale, not the country just chosen, so travelling or
 * living abroad doesn't quietly change the UI language.
 */
export const OnboardingLanguageStep = () => {
  const { language } = useSettings({ language: sourceLocale as string })
  const activeLanguage = resolveLocale(language.value, getBrowserLanguages())

  return (
    <div className="flex w-full flex-1 flex-col justify-center">
      <OnboardingStepHeader
        icon={<Languages className="size-10 text-primary" />}
        title="Which language do you prefer?"
        description="Thunderbolt will use it across the app. You can change it later in Preferences."
      />

      <div className="mt-10">
        <Select value={activeLanguage} onValueChange={(value) => void language.setValue(value)}>
          <SelectTrigger className="w-full" aria-label="Language">
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
