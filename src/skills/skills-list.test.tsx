/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test'
import type { ComponentProps } from 'react'

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createTestProvider } from '@/test-utils/test-provider'
import '@/test-utils/framer-motion-mock'
import { SkillsList } from './skills-list'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

afterEach(cleanup)

const renderList = (overrides: Partial<ComponentProps<typeof SkillsList>> = {}) => {
  const TestProvider = createTestProvider()
  return render(
    <TestProvider>
      <SkillsList
        skills={[]}
        activeSkillId={null}
        isEnabled={() => true}
        onToggleEnabled={mock()}
        onCreate={mock()}
        onSelectSkill={mock()}
        onEditSkill={mock()}
        onDeleteSkill={mock()}
        {...overrides}
      />
    </TestProvider>,
  )
}

describe('SkillsList loading state', () => {
  it('is aria-busy and withholds the empty state while the query loads', () => {
    const { container } = renderList({ isLoading: true })
    expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument()
    expect(screen.queryByText('No skills yet')).not.toBeInTheDocument()
  })

  it('drops aria-busy and shows the empty state once loaded', () => {
    const { container } = renderList({ isLoading: false })
    expect(container.querySelector('[aria-busy]')).toBeNull()
    expect(screen.getByText('No skills yet')).toBeInTheDocument()
  })
})
