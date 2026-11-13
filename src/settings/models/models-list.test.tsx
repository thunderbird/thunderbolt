/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test'
import type { ComponentProps } from 'react'

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createTestProvider } from '@/test-utils/test-provider'
import { ModelsList } from './models-list'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

afterEach(cleanup)

const renderList = (overrides: Partial<ComponentProps<typeof ModelsList>> = {}) => {
  const TestProvider = createTestProvider()
  return render(
    <TestProvider>
      <ModelsList
        models={[]}
        activeModelId={null}
        onSelect={mock()}
        onToggle={mock()}
        onEdit={mock()}
        onRemove={mock()}
        onAdd={mock()}
        {...overrides}
      />
    </TestProvider>,
  )
}

describe('ModelsList loading state', () => {
  it('is aria-busy and withholds the empty state while the query loads', () => {
    const { container } = renderList({ isLoading: true })
    expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument()
    expect(screen.queryByText('No models configured')).not.toBeInTheDocument()
  })

  it('drops aria-busy and shows the empty state once loaded', () => {
    const { container } = renderList({ isLoading: false })
    expect(container.querySelector('[aria-busy]')).toBeNull()
    expect(screen.getByText('No models configured')).toBeInTheDocument()
  })
})
