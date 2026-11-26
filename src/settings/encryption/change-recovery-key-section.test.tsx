/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import 'fake-indexeddb/auto'
import { clearAllKeys, generateAK, markAKUnverified, storeAK, storeDEK } from '@/crypto'
import { HttpClientProvider } from '@/contexts/http-client-context'
import { createMockHttpClient } from '@/test-utils/http-client'
import { getClock } from '@/testing-library'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { ChangeRecoveryKeySection } from './change-recovery-key-section'

const unverifiedCopy =
  "This device can't change the recovery phrase because its encryption keys couldn't be verified. Change it from a device that was trusted before."

describe('ChangeRecoveryKeySection', () => {
  beforeEach(async () => {
    await clearAllKeys()
    await storeAK(await generateAK(), { keyVersion: null, primaryKeyId: '0' })
    await storeDEK('0', 'd3JhcHBlZA==')
  })

  afterEach(async () => {
    cleanup()
    await clearAllKeys()
  })

  it('explains why an unverified device cannot change the phrase', async () => {
    await markAKUnverified()
    render(
      <HttpClientProvider httpClient={createMockHttpClient()}>
        <ChangeRecoveryKeySection />
      </HttpClientProvider>,
    )
    for (let attempt = 0; attempt < 20 && !screen.queryByText(unverifiedCopy); attempt++) {
      await act(async () => {
        getClock().tick(10)
        await getClock().runAllAsync()
      })
    }

    const button = screen.getByRole('button', { name: 'Change Recovery Phrase' })
    expect(button).toBeDisabled()
    expect(button).toHaveAccessibleDescription(unverifiedCopy)
  })
})
