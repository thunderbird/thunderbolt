/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useLanguageSetting } from '@/hooks/use-language-setting'
import { languageOptions } from '@/i18n/language-options'
import { useActiveLocale } from '@/i18n/use-active-locale'
import { useLingui } from '@lingui/react/macro'
import { Globe } from 'lucide-react'

/**
 * Language picker for the unauthenticated waitlist screen.
 *
 * Writes the same synced `language` setting the Preferences picker does — the
 * settings database is local-first and mounted above the router, so it is
 * reachable before sign-in and the choice uploads with the account once one
 * exists. Going through `useLanguageSetting` also marks the setting as an
 * explicit edit, which is what stops `useAppLanguage` from later re-seeding it
 * from `navigator.languages` and discarding the choice.
 *
 * It is not only about the UI: `/waitlist/join` carries `X-App-Language`, so
 * this is also what decides which language the waitlist and sign-in emails
 * arrive in (THU-824).
 *
 * Styled as quiet chrome rather than a form control — it sits under the legal
 * text and must not compete with the email field or the submit button.
 */
export const WaitlistLanguagePicker = () => {
  const { t } = useLingui()
  const { setLanguage } = useLanguageSetting()
  // The published locale, not the raw setting: while the setting is still unset
  // this reflects what the app actually negotiated, so the trigger never shows a
  // language the user is not currently reading.
  const activeLanguage = useActiveLocale()

  return (
    <Select value={activeLanguage} onValueChange={(value) => void setLanguage(value)}>
      <SelectTrigger
        size="sm"
        aria-label={t`Language`}
        className="text-muted-foreground hover:text-foreground w-auto gap-1.5 border-0 bg-transparent px-2 shadow-none dark:bg-transparent"
      >
        <Globe aria-hidden="true" />
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
  )
}
