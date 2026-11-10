/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, expect, it } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'
import { StrictMode } from 'react'
import type { PagePresentation } from '@shared/page-protocol'
import { PageSlot } from './page-slot'
import { usePageStore } from './page-store'

beforeEach(() => usePageStore.setState({ sessions: [], activeId: null }))
afterEach(cleanup)
const create = (presentation: PagePresentation = 'inline') =>
  usePageStore
    .getState()
    .ensure({ id: 'document', title: 'Document', source: { kind: 'html', html: '<input>' } }, { presentation })
const flushCommit = async () =>
  act(async () => {
    await Promise.resolve()
  })

it('disposes an inline-only document after its transcript unmounts', async () => {
  const id = create()
  const view = render(<PageSlot sessionId={id} mode="inline" />)
  view.unmount()
  await flushCommit()
  expect(usePageStore.getState().sessions).toHaveLength(0)
})

it('retains the same document when a slot transfers to the sidebar or expanded route', async () => {
  const id = create()
  const view = render(<PageSlot sessionId={id} mode="inline" />)
  act(() => usePageStore.getState().present(id, 'sidebar'))
  view.rerender(<PageSlot sessionId={id} mode="sidebar" />)
  await flushCommit()
  expect(usePageStore.getState().sessions[0].id).toBe(id)
  act(() => usePageStore.getState().present(id, 'expanded'))
  view.rerender(<PageSlot sessionId={id} mode="expanded" />)
  await flushCommit()
  expect(usePageStore.getState().sessions[0].id).toBe(id)
  view.unmount()
  await flushCommit()
  expect(usePageStore.getState().sessions[0].id).toBe(id)
})

it('retains repeated inline cards until the final copy unmounts', async () => {
  const id = create()
  const first = render(<PageSlot sessionId={id} mode="inline" />)
  const second = render(<PageSlot sessionId={id} mode="inline" />)
  first.unmount()
  await flushCommit()
  expect(usePageStore.getState().sessions[0].id).toBe(id)
  second.unmount()
  await flushCommit()
  expect(usePageStore.getState().sessions).toHaveLength(0)
})

it('does not dispose the Strict Mode replacement slot', async () => {
  const id = create()
  render(
    <StrictMode>
      <PageSlot sessionId={id} mode="inline" />
    </StrictMode>,
  )
  await flushCommit()
  expect(usePageStore.getState().sessions[0].id).toBe(id)
})
