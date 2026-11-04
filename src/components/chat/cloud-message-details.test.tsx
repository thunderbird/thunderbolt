/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { afterEach, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { UIMessageMetadata } from '@/types'
import { CloudMessageDetails } from './cloud-message-details'

afterEach(cleanup)

const cloud: NonNullable<UIMessageMetadata['cloud']> = {
  agentId: 'agent',
  conversationId: 'conversation',
  runId: 'run',
  commandId: 'command',
  status: 'completed',
  sequence: 1,
  recordIds: [],
}

it('keeps ordinary and completed cloud replies free of extra status chrome', () => {
  const view = render(<CloudMessageDetails cloud={undefined} />)
  expect(view.container).toBeEmptyDOMElement()
  view.rerender(<CloudMessageDetails cloud={cloud} />)
  expect(view.container).toBeEmptyDOMElement()
})

it('shows recovery status and opens saved files in the shared artifact library', () => {
  render(
    <MemoryRouter>
      <CloudMessageDetails cloud={{ ...cloud, status: 'uncertain', artifactIds: ['file-id'] }} />
    </MemoryRouter>,
  )
  expect(screen.getByRole('status')).toHaveTextContent('Action outcome unknown')
  expect(screen.getByRole('link', { name: 'Open artifact' })).toHaveAttribute('href', '/artifacts?artifact=file-id')
})
