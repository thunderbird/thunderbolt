/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Print adoption and spend for a time window, read from the usage ledger.
 *
 *   bun run usage-report --from 2026-10-26 --to 2026-11-02 --tz Europe/London
 *
 * `--from` is inclusive and `--to` exclusive; a bare date means midnight UTC.
 * `--tz` (default UTC) only decides which day and hour a turn lands in.
 * `--json` prints the report as JSON instead of Markdown.
 *
 * It reads `DATABASE_URL` like the server does. On Render the database only
 * accepts private connections, so run it on the backend service (`render ssh`).
 */

import { closeDb, db } from '@/db/client'
import { formatUsageReport, getUsageReport } from '@/inference/usage-report'
import { parseArgs } from 'node:util'

const parseInstant = (name: string, value: string | undefined): Date => {
  const instant = new Date(value ?? '')
  if (Number.isNaN(instant.getTime())) {
    throw new Error(`--${name} must be a date or an ISO timestamp, got ${value ?? 'nothing'}`)
  }
  return instant
}

const toJson = (report: unknown) =>
  JSON.stringify(report, (_key, value) => (typeof value === 'bigint' ? value.toString() : value), 2)

const main = async () => {
  const { values } = parseArgs({
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      tz: { type: 'string', default: 'UTC' },
      json: { type: 'boolean', default: false },
    },
  })
  const report = await getUsageReport(db, {
    from: parseInstant('from', values.from),
    to: parseInstant('to', values.to),
    timeZone: values.tz,
  })
  process.stdout.write(`${values.json ? toJson(report) : formatUsageReport(report)}\n`)
}

if (import.meta.main) {
  try {
    await main()
  } finally {
    await closeDb()
  }
  // When OTEL is configured, the bunfig.toml preload's batch exporter keeps
  // the event loop alive, so a one-shot script ends the process itself.
  process.exit(0)
}
