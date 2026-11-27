/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import type { Timestamp } from '@shared/admin-api'
import { toLocalDay } from '../../components/date-field'

/**
 * A SCIM credential's expiry from a date input (`YYYY-MM-DD`): the end of that day in local time,
 * so it works through the whole day the admin picked. Undefined for no date, which the server
 * answers with its default lifetime.
 */
export const toExpiresAt = (date: string): Timestamp | undefined => {
  if (!date) {
    return undefined
  }
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year, month - 1, day, 23, 59, 59, 999).toISOString()
}

/** Today as a date input value, in local time: the earliest expiry a credential can take. */
export const todayDateInput = (now = new Date()) => toLocalDay(now)
