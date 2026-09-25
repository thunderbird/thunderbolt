/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, it, spyOn } from 'bun:test'
import { observeDbReadiness, reportDbDiagnostic } from './db-diagnostic'

it('emits finite labels with the original category precedence and no error text', () => {
  const previous = import.meta.env.VITE_DB_DIAGNOSTIC
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    import.meta.env.VITE_DB_DIAGNOSTIC = 'true'
    reportDbDiagnostic(
      'query',
      'rejected',
      new Error('quota secret', { cause: new Error('NoModificationAllowedError private path') }),
    )
    expect(warn).toHaveBeenCalledWith('[db-diagnostic] query=rejected category=locked name=other')
    expect(warn).toHaveBeenCalledTimes(1)
  } finally {
    import.meta.env.VITE_DB_DIAGNOSTIC = previous
    warn.mockRestore()
  }
})

it('skips disabled diagnostics and observes readiness without awaiting it', async () => {
  const previous = import.meta.env.VITE_DB_DIAGNOSTIC
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    import.meta.env.VITE_DB_DIAGNOSTIC = 'false'
    observeDbReadiness(() => {
      throw new Error('disabled diagnostics must not access PowerSync')
    })
    expect(warn).not.toHaveBeenCalled()

    import.meta.env.VITE_DB_DIAGNOSTIC = 'true'
    const readiness = Promise.resolve()
    expect(observeDbReadiness(() => ({ waitForReady: () => readiness }))).toBeUndefined()
    expect(warn).toHaveBeenCalledWith('[db-diagnostic] readiness=pending category=other name=other')
    await readiness
    expect(warn).toHaveBeenCalledWith('[db-diagnostic] readiness=ready category=other name=other')
  } finally {
    import.meta.env.VITE_DB_DIAGNOSTIC = previous
    warn.mockRestore()
  }
})
