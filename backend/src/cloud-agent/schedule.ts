/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { CronExpressionParser } from 'cron-parser'
import type { CloudScheduleConfig } from '@shared/cloud-agent/contracts'

/** Advance from now, coalescing missed occurrences rather than replaying a backlog. */
export const nextOccurrence = (config: CloudScheduleConfig, after: Date): string => {
  new Intl.DateTimeFormat('en', { timeZone: config.timezone }).format(after)
  if (config.cadence.type === 'interval') {
    return new Date(after.getTime() + config.cadence.minutes * 60_000).toISOString()
  }
  // Starting before the transition lets cron-parser consistently choose the first repeated wall time,
  // even when a delayed scheduler wakes during the second occurrence.
  const occurrences = CronExpressionParser.parse(`${config.cadence.minute} ${config.cadence.hour} * * *`, {
    currentDate: new Date(after.getTime() - 48 * 60 * 60_000),
    tz: config.timezone,
  })
  const wallClock = new Intl.DateTimeFormat('en', {
    timeZone: config.timezone,
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  })
  for (;;) {
    const next = occurrences.next().toDate()
    if (next <= after) {
      continue
    }
    const parts = wallClock.formatToParts(next)
    // Some cron implementations shift a missing spring-forward time; our policy skips that day.
    if (
      Number(parts.find((part) => part.type === 'hour')?.value) !== config.cadence.hour ||
      Number(parts.find((part) => part.type === 'minute')?.value) !== config.cadence.minute
    ) {
      continue
    }
    return next.toISOString()
  }
}

/** A stable occurrence key makes a retry after a crash the same command. */
export const scheduleCommandId = (scheduleId: string, due: string): string => {
  const digest = new Bun.CryptoHasher('sha256').update(`${scheduleId}:${new Date(due).toISOString()}`).digest('hex')
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`
}
