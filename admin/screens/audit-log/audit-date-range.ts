/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { toDate } from '@/i18n/format'
import { toLocalDay } from '../../components/date-field'

/** The ISO start of a date input's `YYYY-MM-DD` day, in local time: the audit `from` bound. */
export const toRangeStart = (day: string): string => toDate(day).toISOString()

/** The ISO end of a date input's `YYYY-MM-DD` day, in local time: the audit `to` bound, inclusive. */
export const toRangeEnd = (day: string): string => {
  const end = toDate(day)
  end.setHours(23, 59, 59, 999)
  return end.toISOString()
}

/** A bound back to the local `YYYY-MM-DD` a date input shows, or '' for none. */
export const toDayInput = (iso: string | undefined): string => {
  if (!iso) {
    return ''
  }
  const date = toDate(iso)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  return toLocalDay(date)
}
