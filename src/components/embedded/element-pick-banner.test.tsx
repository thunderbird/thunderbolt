/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { ElementPickBanner } from './element-pick-banner'

const noop = () => {}

describe('ElementPickBanner', () => {
  afterEach(() => {
    cleanup()
  })

  it('announces what picking does while open', () => {
    render(<ElementPickBanner open canConfirm={false} onConfirm={noop} onCancel={noop} />)

    expect(screen.getByRole('status')).toHaveTextContent('Select an element to add it to the chat')
  })

  it('leaves picking from the Cancel button', () => {
    const onCancel = mock(noop)
    render(<ElementPickBanner open canConfirm={false} onConfirm={noop} onCancel={onCancel} />)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('offers no Add button until a tap has chosen something', () => {
    render(<ElementPickBanner open canConfirm={false} onConfirm={noop} onCancel={noop} />)

    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull()
  })

  it('asks for confirmation and commits from the Add button after a tap', () => {
    const onConfirm = mock(noop)
    render(<ElementPickBanner open canConfirm onConfirm={onConfirm} onCancel={noop} />)

    expect(screen.getByRole('status')).toHaveTextContent('Add to chat?')
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('offers Deselect rather than Cancel once something is chosen', () => {
    const onCancel = mock(noop)
    render(<ElementPickBanner open canConfirm onConfirm={noop} onCancel={onCancel} />)

    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Deselect' }))

    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('stays silent and out of reach while closed', () => {
    render(<ElementPickBanner open={false} canConfirm={false} onConfirm={noop} onCancel={noop} />)

    expect(screen.getByRole('status')).toBeEmptyDOMElement()
    expect(screen.getByText('Cancel').closest('[inert]')).not.toBeNull()
  })
})
