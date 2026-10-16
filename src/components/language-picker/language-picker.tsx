/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useLanguageSetting } from '@/hooks/use-language-setting'
import { languageLabel, languageOptions } from '@/i18n/language-options'
import { useActiveLocale } from '@/i18n/use-active-locale'
import { cn } from '@/lib/utils'
import { useLingui } from '@lingui/react/macro'
import { Globe } from 'lucide-react'

type LanguagePickerProps = {
  /** Trigger height, as `SelectTrigger` sizes it. `sm` is the waitlist's quiet chrome. */
  size?: 'sm' | 'default'
  /** Extra trigger classes, merged after the defaults. */
  className?: string
  /** Globe only, with the current language left to screen readers. For the
   *  collapsed sidebar rail, where nothing wider than an icon fits. */
  iconOnly?: boolean
}

/**
 * Language picker for screens that have no Settings to reach: the
 * unauthenticated waitlist, and the sidebar in minimal mode (see
 * `selectMinimalMode`).
 *
 * Writes the same synced `language` setting the Preferences picker does. The
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
 * Styled as quiet chrome rather than a form control. On the waitlist it sits
 * under the legal text and must not compete with the email field or the
 * submit button; other hosts pass `className` to fit it in.
 */
export const LanguagePicker = ({ size = 'sm', className, iconOnly = false }: LanguagePickerProps) => {
  const { t } = useLingui()
  const { setLanguage } = useLanguageSetting()
  // The published locale, not the raw setting: while the setting is still unset
  // this reflects what the app actually negotiated, so the trigger never shows a
  // language the user is not currently reading.
  const activeLanguage = useActiveLocale()
  // The icon-only trigger has no visible text, and an `aria-label` replaces its
  // content as the accessible name, so the current language goes in the label.
  const currentLanguage = languageLabel(activeLanguage)
  const label = iconOnly ? t`Language: ${currentLanguage}` : t`Language`

  return (
    <Select value={activeLanguage} onValueChange={(value) => void setLanguage(value)}>
      <SelectTrigger
        size={size}
        aria-label={label}
        className={cn(
          'text-muted-foreground hover:text-foreground w-auto gap-1.5 border-0 bg-transparent px-2 shadow-none dark:bg-transparent',
          // The trigger's last svg is the chevron `SelectTrigger` appends.
          iconOnly && 'justify-center px-0 [&>svg:last-child]:hidden',
          className,
        )}
      >
        <Globe aria-hidden="true" />
        {/* Radix's `SelectValue` drops `className`, hence the wrapper. */}
        {iconOnly ? (
          <span className="sr-only">
            <SelectValue />
          </span>
        ) : (
          <SelectValue />
        )}
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
