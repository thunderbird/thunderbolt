/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import type { AgentDescriptor } from '@shared/agent-descriptors'
import { DescriptorForm } from './descriptor-form'

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
})
