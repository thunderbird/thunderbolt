/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { useSettings } from '@/hooks/use-settings'
import { useActiveLocale } from '@/i18n/use-active-locale'

/** Whether clock times read 12-hour: the user's `time_format`, or the locale's own convention until it's seeded. */
export const useHour12 = () => {
  const { timeFormat } = useSettings({ time_format: '' })
  const locale = useActiveLocale()
  if (timeFormat.value === '') {
    return new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions().hour12 === true
  }
  return timeFormat.value === '12h'
}
