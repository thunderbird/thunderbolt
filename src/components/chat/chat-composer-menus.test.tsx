/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, mock } from 'bun:test'
import { ChatComposerMenus } from './chat-composer-menus'

afterEach(cleanup)

it.each(['top', 'bottom'] as const)('opens all composer menus toward %s', (side) => {
  render(
    <ChatComposerMenus
      side={side}
      disabled={false}
      environment={{ value: 'local', locked: false, onChange: () => {} }}
      approvalMode="ask"
      onApprovalChange={() => {}}
      onUploadFile={() => {}}
    />,
  )
  const triggers = ['Execution environment', 'Tool approvals', 'Add to chat'].map((name) =>
    screen.getByRole('button', { name }),
  )
  for (const trigger of triggers) {
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
    expect(document.querySelector('[role="menu"][data-state="open"]')).toHaveAttribute('data-side', side)
  }
})

it('replaces sibling menus in both directions, including the add menu', () => {
  const onEnvironmentChange = mock(() => {})
  const onApprovalChange = mock(() => {})
  render(
    <ChatComposerMenus
      disabled={false}
      environment={{ value: 'local', locked: false, onChange: onEnvironmentChange }}
      approvalMode="ask"
      onApprovalChange={onApprovalChange}
      onUploadFile={() => {}}
    />,
  )
  const environment = screen.getByRole('button', { name: 'Execution environment' })
  const approvals = screen.getByRole('button', { name: 'Tool approvals' })
  const add = screen.getByRole('button', { name: 'Add to chat' })
  for (const target of [environment, approvals, environment, add, approvals, add]) {
    fireEvent.pointerDown(target, { button: 0, ctrlKey: false })
    expect(document.querySelectorAll('[role="menu"][data-state="open"]')).toHaveLength(1)
    for (const trigger of [environment, approvals, add]) {
      expect(trigger).toHaveAttribute('aria-expanded', String(trigger === target))
    }
  }
  expect(onEnvironmentChange).not.toHaveBeenCalled()
  expect(onApprovalChange).not.toHaveBeenCalled()
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  expect(document.querySelectorAll('[role="menu"][data-state="open"]')).toHaveLength(0)
})

it('closes after selection and forwards only the selected setting', () => {
  const onApprovalChange = mock(() => {})
  render(
    <ChatComposerMenus
      disabled={false}
      environment={{ value: 'local', locked: false, onChange: () => {} }}
      approvalMode="ask"
      onApprovalChange={onApprovalChange}
    />,
  )
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Tool approvals' }), { button: 0, ctrlKey: false })
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Full access' }))
  expect(onApprovalChange).toHaveBeenCalledWith('full-access')
  expect(screen.getByRole('button', { name: 'Tool approvals' })).toHaveAttribute('aria-expanded', 'false')
})
