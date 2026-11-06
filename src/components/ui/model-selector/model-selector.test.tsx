/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, mock } from 'bun:test'
import { useState } from 'react'
import { createMockModel } from '@/test-utils/chat-store-mocks'
import { ModelSelector } from './model-selector'

afterEach(cleanup)

it('closes an embedded picker before opening model creation', () => {
  const model = createMockModel()
  const createModel = mock(() => {
    expect(screen.queryByRole('button', { name: 'Add Model' })).toBeNull()
  })
  const Picker = () => {
    const [open, setOpen] = useState(true)
    return open ? (
      <ModelSelector
        embedded
        models={[model]}
        selectedModel={model}
        chatThread={null}
        onModelChange={() => {}}
        onClose={() => setOpen(false)}
        onAddModels={createModel}
      />
    ) : null
  }
  render(<Picker />)
  fireEvent.click(screen.getByRole('button', { name: 'Add Model' }))
  expect(createModel).toHaveBeenCalledTimes(1)
})
