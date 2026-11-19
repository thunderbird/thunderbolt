/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import * as registrations from '@/providers/chatgpt-registration'
import { renderWithReactivity, waitForElement } from '@/test-utils/powersync-reactivity-test'
import { ChatGPTAccountPicker } from './chatgpt-account-picker'

describe('ChatGPT account picker', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  beforeEach(resetTestDatabase)
  afterEach(() => {
    cleanup()
    mock.restore()
  })

  it('identifies the active account and distinguishes saved registrations from a new account', async () => {
    spyOn(registrations, 'listChatGPTAccounts').mockResolvedValue([
      { clientId: 'personal', label: 'Personal · personal', active: true },
      { clientId: 'work', label: 'Work · work', active: false },
    ])
    const choose = mock(() => {})
    renderWithReactivity(<ChatGPTAccountPicker onChoose={choose} onCancel={() => {}} isPending={false} />)
    const trigger = await waitForElement(() => screen.queryByRole('button', { name: 'Choose ChatGPT account' }))
    expect(screen.getByText('Personal · personal')).toBeVisible()
    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0 })
    })
    expect(screen.getByLabelText('Active account')).toBeVisible()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Work · work' }))
    expect(choose).toHaveBeenLastCalledWith('work')
    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0 })
    })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Use another ChatGPT account' }))
    expect(choose).toHaveBeenLastCalledWith(null)
  })

  it('prevents competing switches and lets the user cancel the pending authorization', async () => {
    spyOn(registrations, 'listChatGPTAccounts').mockResolvedValue([
      { clientId: 'personal', label: 'Personal', active: true },
    ])
    const cancel = mock(() => {})
    const choose = mock(() => {})
    const view = renderWithReactivity(
      <ChatGPTAccountPicker onChoose={choose} onCancel={cancel} isPending={false} disabled />,
    )
    expect(await waitForElement(() => screen.queryByRole('button', { name: 'Choose ChatGPT account' }))).toBeDisabled()
    view.rerender(<ChatGPTAccountPicker onChoose={choose} onCancel={cancel} isPending />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel connection' }))
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(choose).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Choose ChatGPT account' })).toBeNull()
  })

  it('does not add an account menu before the first registration', async () => {
    const list = spyOn(registrations, 'listChatGPTAccounts').mockResolvedValue([])
    const view = renderWithReactivity(
      <ChatGPTAccountPicker onChoose={() => {}} onCancel={() => {}} isPending={false} />,
    )
    await act(async () => {
      await list.mock.results[0].value
    })
    expect(list).toHaveBeenCalledTimes(1)
    expect(view.container.textContent).toBe('')
  })
})
