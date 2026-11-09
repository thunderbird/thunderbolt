/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { getClock } from '@/testing-library'
import { useAddedToChatStore } from './added-to-chat-store'
import { AddedToChatToast } from './added-to-chat-toast'

const show = () => act(() => useAddedToChatStore.getState().show())
const tick = (ms: number) =>
  act(async () => {
    await getClock().tickAsync(ms)
  })

describe('AddedToChatToast', () => {
  beforeEach(() => {
    useAddedToChatStore.setState({ isOpen: false, shownCount: 0 })
  })

  afterEach(cleanup)

  it('stays silent until something is added', () => {
    render(<AddedToChatToast />)

    expect(screen.getByRole('status')).toHaveTextContent('')
  })

  it('announces the confirmation when shown', () => {
    render(<AddedToChatToast />)

    show()

    expect(screen.getByRole('status')).toHaveTextContent('Added to chat')
  })

  it('dismisses itself after three seconds', async () => {
    render(<AddedToChatToast />)
    show()

    await tick(2_999)
    expect(useAddedToChatStore.getState().isOpen).toBe(true)

    await tick(1)
    expect(useAddedToChatStore.getState().isOpen).toBe(false)
  })

  it('restarts the timer when another element is added while it is open', async () => {
    render(<AddedToChatToast />)
    show()
    await tick(2_000)

    show()
    await tick(2_999)
    expect(useAddedToChatStore.getState().isOpen).toBe(true)

    await tick(1)
    expect(useAddedToChatStore.getState().isOpen).toBe(false)
  })
})
