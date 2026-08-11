/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import 'fake-indexeddb/auto'
import { useConfigStore } from '@/api/config-store'
import { HttpClientProvider } from '@/contexts/http-client-context'
import { generateAK, storeAK, storeWrappedDEK } from '@/crypto'
import { RotationStaleError } from '@/services/encryption'
import { createMockHttpClient } from '@/test-utils/http-client'
import { waitForElement } from '@/test-utils/powersync-reactivity-test'
import { getClock } from '@/testing-library'
import '@testing-library/jest-dom'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { ChangeRecoveryKeySection } from './change-recovery-key-section'

const newPhrase = 'alpha bravo charlie delta echo foxtrot golf hotel india juliett kilo lima'

const deleteKeyDatabase = (): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase('thunderbolt-keys')
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })

/** Seed a complete v2 key hierarchy so the REAL isE2eeReady reads "ready". */
const seedKeys = async () => {
  await storeAK(await generateAK())
  await storeWrappedDEK('0', 'd3JhcHBlZA==')
}

const renderSection = (rotate: () => Promise<string>) =>
  render(
    <HttpClientProvider httpClient={createMockHttpClient()}>
      <ChangeRecoveryKeySection rotate={rotate} />
    </HttpClientProvider>,
  )

/** Yield to the real event loop a few times so the IndexedDB-backed ready
 *  check settles (fake-indexeddb schedules on real macrotasks, which a single
 *  fake-clock flush never reaches). */
const settleAsyncWork = async (cycles = 5) => {
  for (let i = 0; i < cycles; i += 1) {
    await act(async () => {
      getClock().tick(10)
      await getClock().runAllAsync()
    })
  }
}

const changeButton = () => screen.queryByRole('button', { name: 'Change Recovery Phrase' })

describe('ChangeRecoveryKeySection', () => {
  beforeEach(async () => {
    await deleteKeyDatabase()
    // Drive the REAL isE2eeReady via the config store + fake IndexedDB instead
    // of mocking '@/db/encryption' (module mocks on it leak across files).
    useConfigStore.setState({ config: { e2eeEnabled: true } })
  })

  afterEach(() => {
    useConfigStore.setState({ config: {} })
  })

  it('renders nothing when E2EE is not enabled', async () => {
    useConfigStore.setState({ config: {} })
    await seedKeys()
    renderSection(mock(async () => newPhrase))
    await settleAsyncWork()

    expect(changeButton()).not.toBeInTheDocument()
  })

  it('renders nothing before the v2 key hierarchy exists locally', async () => {
    renderSection(mock(async () => newPhrase))
    await settleAsyncWork()

    expect(changeButton()).not.toBeInTheDocument()
  })

  it('rotates the AK and shows the new phrase exactly once behind the confirmation gate', async () => {
    await seedKeys()
    const rotate = mock(async () => newPhrase)
    renderSection(rotate)

    fireEvent.click(await waitForElement(changeButton))
    await waitForElement(() => screen.queryByText('Change your recovery phrase?'))

    fireEvent.click(screen.getByRole('button', { name: 'Generate new phrase' }))
    await waitForElement(() => screen.queryByText(newPhrase))

    expect(rotate).toHaveBeenCalledTimes(1)
    // Both the sr-only dialog title and the visible heading carry the title.
    expect(screen.getAllByText('Save your new recovery phrase').length).toBeGreaterThan(0)

    // Confirmation gate: Done stays disabled until "I saved it" is checked.
    const doneButton = screen.getByRole('button', { name: 'Done' })
    expect(doneButton).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox'))
    expect(doneButton).toBeEnabled()

    fireEvent.click(doneButton)
    await settleAsyncWork()
    expect(screen.queryByText(newPhrase)).not.toBeInTheDocument()
  })

  it('surfaces RotationStaleError with a retry affordance that succeeds on the second attempt', async () => {
    await seedKeys()
    let attempts = 0
    const rotate = mock(async () => {
      attempts += 1
      if (attempts === 1) {
        throw new RotationStaleError()
      }
      return newPhrase
    })
    renderSection(rotate)

    fireEvent.click(await waitForElement(changeButton))
    await waitForElement(() => screen.queryByText('Change your recovery phrase?'))
    fireEvent.click(screen.getByRole('button', { name: 'Generate new phrase' }))

    const alert = await waitForElement(() => screen.queryByRole('alert'))
    expect(alert).toHaveTextContent('Your account keys changed while preparing the new phrase. Please try again.')

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitForElement(() => screen.queryByText(newPhrase))

    expect(rotate).toHaveBeenCalledTimes(2)
    expect(screen.getByText(newPhrase)).toBeInTheDocument()
  })
})
