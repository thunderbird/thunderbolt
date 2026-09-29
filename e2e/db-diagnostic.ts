/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Accept only fixed database labels from browser console output. */
export const parseDbDiagnostic = (message: string): { phase: 'readiness' | 'query'; label: string } | null => {
  const match =
    /^\[db-diagnostic\] (readiness|query)=(pending|ready|rejected|timed_out) category=(locked|quota|schema|open|worker|wasm|sqlite|other) name=(AbortError|InvalidStateError|NoModificationAllowedError|NotAllowedError|QuotaExceededError|SQLiteError|TypeError|other)$/.exec(
      message,
    )
  if (!match) return null
  return {
    phase: match[1] as 'readiness' | 'query',
    label: match[0],
  }
}
