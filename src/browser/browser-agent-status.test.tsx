/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, fireEvent, render } from '@testing-library/react'
import { expect, it } from 'bun:test'
import { getClock } from '@/testing-library'
import { BrowserAgentStatus } from './browser-agent-status'
import { browserController } from './browser-controller'

it('keeps the same banner mounted between tools and lets the user stop during model thinking', async () => {
  const unregister = browserController.registerPanel({
    listTabs: () => [{ id: 'one', title: 'Example', url: 'https://example.com', active: true, isLoading: false }],
  })
  const finish = browserController.startAgentTurn('banner-test')
  const agent = browserController.forAgentTurn('banner-test')
  const view = render(<BrowserAgentStatus tabId="one" />)
  try {
    expect(view.queryByRole('status')).toBeNull()
    await act(async () => {
      agent.claimPage('one')
    })
    const banner = view.getByRole('status')
    expect(banner).toHaveTextContent('Agent is using this tab')
    await act(async () => {
      await getClock().tickAsync(60_000)
    })
    await act(async () => {
      agent.claimPage('one')
    })
    expect(view.getByRole('status')).toBe(banner)
    fireEvent.click(view.getByRole('button', { name: 'Stop control' }))
    expect(banner).toHaveTextContent('Browser control paused')
    expect(() => agent.claimPage('one')).toThrow('stopped')
    fireEvent.click(view.getByRole('button', { name: 'Resume' }))
    expect(view.queryByRole('status')).toBeNull()
    await act(async () => {
      agent.claimPage('one')
    })
    act(finish)
    expect(view.queryByRole('status')).toBeNull()
  } finally {
    view.unmount()
    finish()
    unregister()
    browserController.resume()
  }
})
