/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { mockLocationData } from '@/test-utils/http-client'
import { createTestProvider } from '@/test-utils/test-provider'
import { useTrustDomainRegistry } from '@/stores/trust-domain-registry'
import { getClock } from '@/testing-library'
import { act, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { OnboardingDialog } from './onboarding-dialog'

/** Flush pending settings/provider queries under the global fake clock. */
const settle = async () => {
  await act(async () => {
    await getClock().runAllAsync()
  })
}

beforeAll(async () => {
  await setupTestDatabase()
})
afterAll(async () => {
  await teardownTestDatabase()
})
afterEach(async () => {
  await resetTestDatabase()
})

const wrapper = ({ children }: { children: ReactNode }) => {
  const TestProvider = createTestProvider({ mockResponse: mockLocationData })
  return (
    <MemoryRouter>
      <TestProvider>{children}</TestProvider>
    </MemoryRouter>
  )
}

describe('OnboardingDialog step-router branching', () => {
  it('server mode does not show the model-provider step', async () => {
    // testing-library.ts seeds a server trust domain by default.
    render(<OnboardingDialog />, { wrapper })
    await settle()
    expect(screen.queryByText('Connect a model provider')).toBeNull()
  })

  it('standalone mode starts on the model-provider step', async () => {
    useTrustDomainRegistry.setState({ activeTrustDomain: { kind: 'standalone' } })
    render(<OnboardingDialog />, { wrapper })
    await settle()
    expect(screen.getByText('Connect a model provider')).toBeTruthy()
  })
})
