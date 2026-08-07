/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import type { AgentDescriptor } from '@shared/agent-descriptors'
import { getClock } from '@/testing-library'
import { DescriptorForm } from './descriptor-form'
import type { OptionSources } from './option-sources'

afterEach(cleanup)

const conditionalDescriptor: AgentDescriptor = {
  id: 'x',
  provider: 'x',
  name: 'X',
  description: 'Deploy X',
  icon: null,
  schemaVersion: 1,
  action: 'deploy',
  steps: [
    {
      id: 's',
      title: 'S',
      fields: [
        { key: 'name', label: 'Name', widget: 'text', required: true, placeholder: 'name' },
        { key: 'mode', label: 'Mode', widget: 'text', default: 'curated' },
        { key: 'apiKey', label: 'API key', widget: 'password', visibleWhen: { field: 'mode', equals: 'byo' } },
      ],
    },
  ],
}

const nameOnly: AgentDescriptor = {
  ...conditionalDescriptor,
  steps: [
    {
      id: 's',
      title: 'S',
      fields: [{ key: 'name', label: 'Name', widget: 'text', required: true, placeholder: 'name' }],
    },
  ],
}

const modelPicker: AgentDescriptor = {
  ...conditionalDescriptor,
  steps: [
    {
      id: 's',
      title: 'S',
      fields: [
        {
          key: 'model',
          label: 'Model',
          widget: 'select',
          required: true,
          source: { kind: 'fetched', sourceId: 'account-models' },
        },
      ],
    },
  ],
}

describe('DescriptorForm', () => {
  it('renders visible fields and hides ones whose visibleWhen guard is unmet', () => {
    render(<DescriptorForm descriptor={conditionalDescriptor} onSubmit={() => {}} onCancel={() => {}} />)
    expect(screen.getByText('Name')).toBeInTheDocument()
    expect(screen.getByText('Mode')).toBeInTheDocument()
    // mode defaults to 'curated', so the byo-only field is hidden.
    expect(screen.queryByText('API key')).not.toBeInTheDocument()
  })

  it('shows the submit label and the descriptor description', () => {
    render(<DescriptorForm descriptor={nameOnly} onSubmit={() => {}} onCancel={() => {}} submitLabel="Deploy agent" />)
    expect(screen.getByRole('button', { name: 'Deploy agent' })).toBeInTheDocument()
    expect(screen.getByText('Deploy X')).toBeInTheDocument()
  })

  it('surfaces a submit-time error next to the buttons', () => {
    render(<DescriptorForm descriptor={nameOnly} onSubmit={() => {}} onCancel={() => {}} error="Deploy failed" />)
    expect(screen.getByText('Deploy failed')).toBeInTheDocument()
  })

  it('fires onCancel from the Cancel button', () => {
    const onCancel = mock(() => {})
    render(<DescriptorForm descriptor={nameOnly} onSubmit={() => {}} onCancel={onCancel} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('renders injected fetched options for a model-picker field', async () => {
    const optionSources: OptionSources = {
      'account-models': {
        options: [
          { value: 'kimi-k2', label: 'Kimi K2' },
          { value: 'qwen3', label: 'Qwen 3' },
        ],
        isLoading: false,
      },
    }
    render(
      <DescriptorForm descriptor={modelPicker} onSubmit={() => {}} onCancel={() => {}} optionSources={optionSources} />,
    )
    const trigger = screen.getByRole('combobox')
    expect(trigger).not.toBeDisabled()
    await act(async () => {
      fireEvent.click(trigger)
      await getClock().runAllAsync()
    })
    expect(screen.getByRole('option', { name: 'Kimi K2' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Qwen 3' })).toBeInTheDocument()
  })

  it('shows a disabled "No models available" select when the source resolves empty', () => {
    const optionSources: OptionSources = { 'account-models': { options: [], isLoading: false } }
    render(
      <DescriptorForm descriptor={modelPicker} onSubmit={() => {}} onCancel={() => {}} optionSources={optionSources} />,
    )
    expect(screen.getByRole('combobox')).toBeDisabled()
    expect(screen.getByText('No models available')).toBeInTheDocument()
  })

  it('shows a disabled "Loading…" select while the source is loading', () => {
    const optionSources: OptionSources = { 'account-models': { options: [], isLoading: true } }
    render(
      <DescriptorForm descriptor={modelPicker} onSubmit={() => {}} onCancel={() => {}} optionSources={optionSources} />,
    )
    expect(screen.getByRole('combobox')).toBeDisabled()
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })

  it('submits the selected model as the spec value', async () => {
    const onSubmit = mock((_spec: Record<string, unknown>) => {})
    const optionSources: OptionSources = {
      'account-models': { options: [{ value: 'kimi-k2', label: 'Kimi K2' }], isLoading: false },
    }
    render(
      <DescriptorForm descriptor={modelPicker} onSubmit={onSubmit} onCancel={() => {}} optionSources={optionSources} />,
    )
    await act(async () => {
      fireEvent.click(screen.getByRole('combobox'))
      await getClock().runAllAsync()
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: 'Kimi K2' }))
      await getClock().runAllAsync()
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Deploy' }))
      await getClock().runAllAsync()
    })
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0][0]).toEqual({ model: 'kimi-k2' })
  })
})
