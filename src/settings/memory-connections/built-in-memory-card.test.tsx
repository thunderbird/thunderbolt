/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { I18nProvider } from '@lingui/react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, mock, test } from 'bun:test'
import { i18n } from '@/i18n'
import { BuiltInMemoryCard, type BuiltInMemoryCardContent } from './built-in-memory-card'

afterEach(cleanup)

const setup = (overrides: Partial<BuiltInMemoryCardContent> = {}, disabled = false) => {
  const memory = {
    content: '# Preferences\n\n- Use **Celsius** unless I ask for Fahrenheit.',
    isLoading: false,
    onView: mock(() => {}),
    onEdit: mock(() => {}),
    ...overrides,
  }
  const onSelect = mock((_id: string) => {})
  const view = render(
    <I18nProvider i18n={i18n}>
      <BuiltInMemoryCard memory={memory} selected={false} disabled={disabled} onSelect={onSelect} />
    </I18nProvider>,
  )
  return { ...view, memory, onSelect }
}

test('preview, edit, compaction, and provider selection are independent actions', () => {
  const { memory, onSelect } = setup()
  fireEvent.click(screen.getByRole('radio', { name: 'Built-in' }))
  expect(onSelect).toHaveBeenCalledWith('builtin')
  expect(memory.onView).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
  expect(memory.onEdit).toHaveBeenCalledTimes(1)
  expect(memory.onView).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Compact' })).toBeNull()
  expect(memory.onView).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'View full memory' }))
  expect(memory.onView).toHaveBeenCalledTimes(1)
  expect(onSelect).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('textbox')).toBeNull()
})

test('renders a bounded Markdown preview without interactive links or remote images', () => {
  const { container } = setup({
    content:
      '# Preferences\n\n- Use **Celsius**.\n\n[My site](https://example.com)\n\n![Private image](https://example.com/tracker.png)',
  })
  const heading = screen.getByRole('heading', { name: 'Preferences' })
  expect(heading).toBeVisible()
  expect(screen.getByRole('listitem')).toHaveTextContent('Use Celsius.')
  expect(container.querySelector('strong')).toHaveTextContent('Celsius')
  expect(screen.getByText('My site')).toBeVisible()
  expect(screen.getByText('Private image')).toBeVisible()
  expect(screen.queryByRole('link')).toBeNull()
  expect(container.querySelector('img[src="https://example.com/tracker.png"]')).toBeNull()
  expect(heading.parentElement).toHaveClass('max-h-28', 'overflow-hidden', 'pointer-events-none')
  expect(screen.getByRole('button', { name: 'View full memory' }).querySelector('button, input')).toBeNull()
})

test('consent disables every card action without losing the preview', () => {
  const { memory, onSelect } = setup({}, true)
  const controls = [screen.getByRole('radio', { name: 'Built-in' }), ...screen.getAllByRole('button')]
  for (const control of controls) {
    expect(control).toBeDisabled()
  }
  for (const button of screen.getAllByRole('button')) {
    fireEvent.click(button)
  }
  expect(memory.onView).not.toHaveBeenCalled()
  expect(memory.onEdit).not.toHaveBeenCalled()
  expect(onSelect).not.toHaveBeenCalled()
  expect(screen.getByRole('heading', { name: 'Preferences' })).toBeVisible()
})

test('loading blocks document actions while keeping provider selection independent', () => {
  setup({ isLoading: true })
  expect(screen.getByRole('status')).toHaveTextContent('Loading memory')
  expect(screen.getByRole('radio', { name: 'Built-in' })).toBeEnabled()
  for (const button of screen.getAllByRole('button')) {
    expect(button).toBeDisabled()
  }
})

test('unavailable compaction cannot dispatch a rewrite or open the full document', () => {
  const { memory } = setup({ content: '' })
  expect(screen.getByText('No memory yet. Click Edit or ask your agent to remember something.')).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Compact' })).toBeNull()
  expect(memory.onView).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Edit' })).toBeEnabled()
})
