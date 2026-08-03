/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createModel } from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { renderWithReactivity, waitForElement } from '@/test-utils/powersync-reactivity-test'
import type { EntityActionIntent } from '@/search/actions/types'
import '@testing-library/jest-dom'
import { cleanup, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { MemoryRouter } from 'react-router'
import { v7 as uuidv7 } from 'uuid'
import ModelsPage from './index'

// A palette action intent is delivered to the page via router `location.state`
// under the `modelsAction` key (see search/actions/entity-actions.ts). Mount
// the page with that state and assert the existing panel/dialog handler fired.
const renderWithIntent = (intent: EntityActionIntent) =>
  renderWithReactivity(
    <MemoryRouter initialEntries={[{ pathname: '/settings/models', state: { modelsAction: JSON.stringify(intent) } }]}>
      <ModelsPage />
    </MemoryRouter>,
    { tables: ['models'] },
  )

const seedUserModel = async (name: string) => {
  const id = uuidv7()
  await createModel(getDb(), {
    id,
    provider: 'openai',
    name,
    model: 'gpt-4',
    isSystem: 0,
    enabled: 1,
  })
  return id
}

describe('ModelsPage palette action intents', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    await resetTestDatabase()
  })

  afterEach(() => {
    cleanup()
  })

  it('opens the Add Model panel for a create intent', async () => {
    renderWithIntent({ type: 'create' })

    await waitForElement(() => screen.queryByRole('heading', { name: 'Add Model' }))
    expect(screen.getByRole('heading', { name: 'Add Model' })).toBeInTheDocument()
  })

  it('opens the Edit Model panel for an edit intent', async () => {
    const id = await seedUserModel('Editable Model')

    renderWithIntent({ type: 'edit', id })

    await waitForElement(() => screen.queryByRole('heading', { name: 'Edit Model' }))
    expect(screen.getByLabelText('Name')).toHaveValue('Editable Model')
  })

  it('opens the delete confirmation dialog for a remove intent', async () => {
    const id = await seedUserModel('Removable Model')

    renderWithIntent({ type: 'remove', id })

    await waitForElement(() => screen.queryByRole('alertdialog'))
    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveTextContent('Delete Model')
  })
})
