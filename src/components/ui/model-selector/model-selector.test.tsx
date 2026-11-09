/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, mock } from 'bun:test'
import { useState } from 'react'
import { createMockModel } from '@/test-utils/chat-store-mocks'
import { ModelSelector } from './model-selector'

afterEach(cleanup)

it.each([false, true])('distinguishes matching model names by provider (embedded: %s)', async (embedded) => {
  const models = [
    createMockModel({ id: 'router', name: 'DeepSeek', provider: 'openrouter' }),
    createMockModel({ id: 'private', name: 'DeepSeek', provider: 'tinfoil', isConfidential: 1 }),
  ]
  const select = mock(() => {})
  render(
    <ModelSelector embedded={embedded} models={models} selectedModel={null} chatThread={null} onModelChange={select} />,
  )
  if (!embedded) {
    fireEvent.click(screen.getByText('Select model'))
  }
  const router = await screen.findByRole('button', { name: 'DeepSeek OpenRouter' })
  const privateModel = screen.getByRole('button', { name: 'DeepSeek Tinfoil' })
  expect(within(privateModel).getByRole('img', { name: 'Tinfoil' })).toBeInTheDocument()
  expect(within(privateModel).queryByLabelText('Private')).toBeNull()
  expect(within(privateModel).queryByText('Private')).toBeNull()
  expect(within(router).getByRole('img', { name: 'OpenRouter' })).toBeInTheDocument()
  fireEvent.click(privateModel)
  expect(select).toHaveBeenCalledWith('private')
})

it('keeps the provider visible when a model is missing its API key', () => {
  const model = createMockModel({ provider: 'openai', apiKey: null })
  render(<ModelSelector embedded models={[model]} selectedModel={null} chatThread={null} onModelChange={() => {}} />)
  const option = screen.getByRole('button', { name: 'Test Model OpenAI' })
  expect(option).toBeDisabled()
  expect(within(option).getByRole('img', { name: 'OpenAI' })).toBeInTheDocument()
  expect(option.querySelector('svg.text-warning')).not.toBeNull()
})

it('shows the provider without a redundant private lock in a standalone composer selector', () => {
  const model = createMockModel({ isConfidential: 1, apiKey: 'test-key' })
  render(
    <ModelSelector
      variant="composer"
      models={[model]}
      selectedModel={model}
      chatThread={null}
      onModelChange={() => {}}
    />,
  )
  const trigger = screen.getByTestId('model-selector-trigger')
  expect(trigger.querySelector('img')).not.toBeNull()
  expect(trigger.querySelector('linearGradient')).toBeNull()
})

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
