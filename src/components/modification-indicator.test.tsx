/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getClock } from '@/testing-library'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, mock } from 'bun:test'
import { ModificationIndicator } from './modification-indicator'

const renderIndicator = (hasModifications: boolean, onReset = mock()) =>
  render(
    <ModificationIndicator as="label" hasModifications={hasModifications} onReset={onReset}>
      Language
    </ModificationIndicator>,
  )

describe('ModificationIndicator', () => {
  it('renders the modified trigger as a real button inside a plain label', () => {
    const { container } = renderIndicator(true)

    const trigger = screen.getByRole('button', { name: /^Language\s*, modified$/ })
    expect(trigger.tagName).toBe('BUTTON')
    expect(trigger).toHaveAttribute('type', 'button')
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog')

    const label = container.querySelector('label')!
    expect(label).toContainElement(trigger)
    for (const attr of ['aria-label', 'aria-haspopup', 'aria-expanded', 'data-state', 'type']) {
      expect(label).not.toHaveAttribute(attr)
    }
  })

  it('names the button from its visible text first, without an aria-label', () => {
    render(
      <ModificationIndicator id="lbl" hasModifications onReset={mock()}>
        Language
      </ModificationIndicator>,
    )

    const trigger = screen.getByRole('button', { name: /^Language\s*, modified$/ })
    expect(trigger).not.toHaveAttribute('aria-label')
    // aria-labelledby users get only the label text, not the hidden suffix
    expect(document.getElementById('lbl')).toHaveTextContent(/^Language$/)
  })

  it('announces a custom ariaLabel after the visible text', () => {
    render(
      <ModificationIndicator hasModifications onReset={mock()} ariaLabel="Modified model">
        Customized model
      </ModificationIndicator>,
    )
    expect(screen.getByRole('button', { name: /^Customized model\s*, Modified model$/ })).toBeInTheDocument()
  })

  it('renders no button when unmodified', () => {
    renderIndicator(false)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('opens with Enter, Space and closes with Escape, returning focus to the trigger', async () => {
    const user = userEvent.setup({ delay: null })
    renderIndicator(true)
    const trigger = screen.getByRole('button', { name: /^Language\s*, modified$/ })

    await user.tab()
    expect(trigger).toHaveFocus()

    await user.keyboard('{Enter}')
    expect(await screen.findByRole('button', { name: 'Reset to Default' })).toBeInTheDocument()

    await user.keyboard('{Escape}')
    await act(async () => {
      await getClock().runAllAsync()
    })
    expect(screen.queryByRole('button', { name: 'Reset to Default' })).toBeNull()
    expect(trigger).toHaveFocus()

    await user.keyboard(' ')
    expect(await screen.findByRole('button', { name: 'Reset to Default' })).toBeInTheDocument()
  })

  it('calls onReset from the popover', async () => {
    const user = userEvent.setup({ delay: null })
    const onReset = mock()
    renderIndicator(true, onReset)

    await user.click(screen.getByRole('button', { name: /^Language\s*, modified$/ }))
    await user.click(await screen.findByRole('button', { name: 'Reset to Default' }))
    expect(onReset).toHaveBeenCalledTimes(1)
  })
})
