/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { act, fireEvent, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { getClock } from '@/testing-library'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { getMemoryDocument, saveMemoryDocument } from '@/dal/memories'
import { createModel, createMcpServer, getSettings, updateSettings } from '@/dal'
import * as dal from '@/dal'
import { ExternalLinkDialogProvider } from '@/components/chat/markdown-utils'
import { HttpClientProvider } from '@/contexts'
import { CreateItemProvider } from '@/components/create-item/context'
import { CreateItemHost } from '@/components/create-item/create-item-host'
import { createMockHttpClient } from '@/test-utils/http-client'
import { MCPProvider } from '@/lib/mcp-provider'
import { invalidateIdentityLifetime } from '@/lib/identity-lifetime'
import { renderWithReactivity, waitForElement } from '@/test-utils/powersync-reactivity-test'
import * as compaction from '@/memory/compact'
import MemorySettingsPage from './index'

beforeAll(setupTestDatabase)
afterAll(teardownTestDatabase)
beforeEach(resetTestDatabase)
const flush = () =>
  act(async () => {
    await getClock().runAllAsync()
  })
const ConnectionsWrapper = ({ children }: { children: ReactNode }) => (
  <HttpClientProvider httpClient={createMockHttpClient()}>
    <MCPProvider>
      <CreateItemProvider>
        <ExternalLinkDialogProvider>{children}</ExternalLinkDialogProvider>
      </CreateItemProvider>
    </MCPProvider>
  </HttpClientProvider>
)
const mount = () =>
  renderWithReactivity(
    <>
      <MemorySettingsPage />
      <CreateItemHost />
    </>,
    {
      route: '/settings/memory',
      tables: ['settings', 'models', 'mcp_servers', 'mcp_secrets'],
      wrapper: ConnectionsWrapper,
    },
  )
const seed = (content: string) => saveMemoryDocument(getDb(), content, { expectedContent: '' })
const editor = () => screen.getByRole('textbox', { name: 'Memory text' })
const document = () => screen.getByRole('document', { name: 'Memory text' })
const panel = () => screen.getByRole('heading', { name: 'Built-in memory' }).closest('section')!
const panelButton = (name: string) => within(panel()).getByRole('button', { name })
/** Open the production lazy aside and wait for its requestAnimationFrame transition. */
const startEditing = async () => {
  const openPanel = screen.queryByRole('heading', { name: 'Built-in memory' })
  if (openPanel) {
    fireEvent.pointerDown(panelButton('More'), { button: 0 })
    fireEvent.click(await waitForElement(() => screen.queryByRole('menuitem', { name: 'Edit' })))
  } else {
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
  }
  await waitForElement(() => screen.queryByRole('textbox', { name: 'Memory text' }))
  await flush()
}
const viewMemory = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'View full memory' }))
  await waitForElement(() => screen.queryByRole('document', { name: 'Memory text' }))
  await flush()
}
const closeMemory = async () => {
  const aside = panel().closest('aside')!
  fireEvent.click(panelButton('Close details'))
  fireEvent.transitionEnd(aside)
  await flush()
}
/** Exercise consent before controls that are intentionally disabled for existing users. */
const enableMemory = async () => {
  fireEvent.click(screen.getByRole('switch', { name: 'Saved memories' }))
  await flush()
}

describe('Memory settings document', () => {
  it('starts read-only with consent off, saves a multiline document, and copies the visible block', async () => {
    const copy = spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    try {
      mount()
      await flush()
      expect(screen.getByRole('switch', { name: 'Saved memories' })).not.toBeChecked()
      expect(screen.getByRole('switch', { name: 'Reference earlier chats' })).not.toBeChecked()
      expect(screen.queryByRole('textbox', { name: 'Memory text' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
      expect(screen.queryByRole('combobox')).toBeNull()
      expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Add connection' })).toBeDisabled()
      expect(screen.getByRole('radio', { name: 'Built-in' })).toBeDisabled()
      await enableMemory()
      await startEditing()
      expect(panelButton('More')).toBeVisible()
      const content =
        '# Preferences\n\n- Use Celsius unless I ask for Fahrenheit.\n\n' + 'A long freeform paragraph. '.repeat(15)
      fireEvent.change(editor(), { target: { value: content } })
      expect(editor()).not.toHaveAttribute('readonly')
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await flush()
      expect((await getMemoryDocument(getDb())).content).toBe(content)
      expect(within(document()).getByRole('heading', { name: 'Preferences' })).toBeVisible()
      expect(within(document()).getByRole('listitem')).toHaveTextContent('Use Celsius unless I ask for Fahrenheit.')
      expect(screen.queryByRole('textbox')).toBeNull()
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy' })))
      expect(copy).toHaveBeenCalledWith(content)
      expect(screen.getByRole('button', { name: 'Copied' }).textContent).toBe('')
      expect(screen.getByRole('button', { name: 'Copied' })).toBeVisible()
    } finally {
      copy.mockRestore()
    }
  })

  it('discards canceled edits and permits clearing the document', async () => {
    await seed('I prefer concise answers.')
    mount()
    await flush()
    await enableMemory()
    await startEditing()
    fireEvent.change(editor(), { target: { value: 'Uncommitted change' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(document()).toHaveTextContent('I prefer concise answers.')
    expect(screen.queryByRole('textbox')).toBeNull()
    await startEditing()
    fireEvent.change(editor(), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await flush()
    expect((await getMemoryDocument(getDb())).content).toBe('')
    expect(document()).toHaveTextContent('No memory yet.')
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('opens a read-only aside from the preview and discards drafts when it closes', async () => {
    await seed('Original saved memory')
    mount()
    await flush()
    await enableMemory()
    expect(screen.queryByRole('document')).toBeNull()
    await viewMemory()
    expect(document()).toHaveTextContent('Original saved memory')
    expect(screen.queryByRole('textbox')).toBeNull()
    await startEditing()
    fireEvent.change(editor(), { target: { value: 'Discard on close' } })
    await closeMemory()
    expect(screen.queryByRole('document')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect((await getMemoryDocument(getDb())).content).toBe('Original saved memory')
    await startEditing()
    expect(editor()).toHaveValue('Original saved memory')
  })

  it('protects a newer synced document while retaining a stale local draft', async () => {
    await seed('Original memory')
    mount()
    await flush()
    await enableMemory()
    await startEditing()
    fireEvent.change(editor(), { target: { value: 'My unsaved edit' } })
    await saveMemoryDocument(getDb(), 'A concurrent edit', { expectedContent: 'Original memory' })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await flush()
    expect((await getMemoryDocument(getDb())).content).toBe('A concurrent edit')
    expect(editor()).toHaveValue('My unsaved edit')
    expect(screen.getByRole('alert')).toHaveTextContent('Memory changed while you were editing')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await flush()
    expect(document()).toHaveTextContent('A concurrent edit')
  })

  it('edits through the More menu, counts characters, and restores the read-only menu after Cancel', async () => {
    await seed('e\u0301👨‍👩‍👧‍👦')
    mount()
    await flush()
    await enableMemory()
    await viewMemory()
    expect(screen.getByText('2 characters')).toBeVisible()
    expect(within(panel()).queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(within(panel()).queryByRole('button', { name: 'Save' })).toBeNull()
    fireEvent.pointerDown(panelButton('More'), { button: 0 })
    const editAction = await waitForElement(() => screen.queryByRole('menuitem', { name: 'Edit' }))
    expect(editAction).toBeVisible()
    fireEvent.click(editAction)
    await waitForElement(() => screen.queryByRole('textbox', { name: 'Memory text' }))
    await flush()
    const footer = panelButton('Save').closest('[data-slot="form-footer"]')
    expect(footer).not.toBeNull()
    expect(footer).toContainElement(panelButton('Cancel'))
    expect(panelButton('More')).toBeVisible()
    expect(within(panel()).queryByRole('button', { name: 'Compact' })).toBeNull()
    fireEvent.change(editor(), { target: { value: '👨‍👩‍👧‍👦' } })
    expect(screen.getByText('1 character')).toBeVisible()
    fireEvent.click(panelButton('Cancel'))
    await flush()
    expect(document()).toHaveTextContent('e\u0301👨‍👩‍👧‍👦')
    expect(panelButton('More')).toBeVisible()
    expect(within(panel()).queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByText('2 characters')).toBeVisible()
  })

  it('selects only one provider, preserves built-in text, and retains the choice while disabled', async () => {
    await seed('Keep my built-in memory')
    await createMcpServer(getDb(), {
      id: 'external-memory',
      name: 'My Mem0',
      url: 'https://mcp.mem0.ai/mcp',
      type: 'http',
      enabled: 0,
    })
    mount()
    await flush()
    await enableMemory()
    expect(screen.getByRole('radio', { name: 'Built-in' })).toBeChecked()
    fireEvent.click(screen.getByRole('radio', { name: 'My Mem0' }))
    await flush()
    expect(screen.getByRole('radio', { name: 'My Mem0' })).toBeChecked()
    expect(screen.getByRole('radio', { name: 'Built-in' })).not.toBeChecked()
    expect(screen.queryByRole('document')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Compact' })).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('Connect and enable this provider')
    expect((await getSettings(getDb(), { memory_provider: 'builtin' })).memoryProvider).toBe('mcp:external-memory')
    fireEvent.click(screen.getByRole('switch', { name: 'Saved memories' }))
    await flush()
    expect(screen.getByRole('radio', { name: 'My Mem0' })).toBeDisabled()
    expect(screen.getByRole('radio', { name: 'My Mem0' })).toBeChecked()
    expect(screen.getByRole('button', { name: 'Manage My Mem0' })).toBeDisabled()
    fireEvent.click(screen.getByRole('switch', { name: 'Saved memories' }))
    await flush()
    expect(screen.getByRole('radio', { name: 'My Mem0' })).toBeChecked()
    expect((await getMemoryDocument(getDb())).content).toBe('Keep my built-in memory')
    fireEvent.click(screen.getByRole('radio', { name: 'Built-in' }))
    await flush()
    await viewMemory()
    expect(document()).toHaveTextContent('Keep my built-in memory')
  })

  it('keeps an open draft reachable when another device switches providers', async () => {
    await seed('Original built-in memory')
    const { triggerChange } = mount()
    await flush()
    await enableMemory()
    await startEditing()
    fireEvent.change(editor(), { target: { value: 'Unsaved local draft' } })
    await updateSettings(getDb(), { memory_provider: 'mcp:external-selected-on-another-device' })
    triggerChange(['settings'])
    await flush()
    expect(editor()).toHaveValue('Unsaved local draft')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await flush()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(document()).toHaveTextContent('Original built-in memory')
    await closeMemory()
    expect(screen.getByRole('radio', { name: 'Built-in' })).toBeEnabled()
    expect(screen.getByRole('radio', { name: 'Built-in' })).not.toBeChecked()
    expect((await getMemoryDocument(getDb())).content).toBe('Original built-in memory')
  })

  it('keeps unavailable selection explicit instead of falling back to built-in', async () => {
    await seed('Do not use as a fallback')
    await updateSettings(getDb(), { memory_provider: 'removed-provider' })
    mount()
    await flush()
    expect(screen.getByRole('radio', { name: 'Built-in' })).not.toBeChecked()
    expect(screen.queryByRole('document')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('Selected provider is unavailable')
    expect((await getSettings(getDb(), { memory_provider: 'builtin' })).memoryProvider).toBe('removed-provider')
  })

  it('bounds the whole document in UTF-8 bytes', async () => {
    mount()
    await flush()
    await enableMemory()
    await startEditing()
    fireEvent.change(editor(), { target: { value: '界'.repeat(2049) } })
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Memory is too long')
    expect((await getMemoryDocument(getDb())).content).toBe('')
  })

  it('keeps the document when memory is disabled and toggles history independently', async () => {
    await seed('Keep this document')
    mount()
    await flush()
    fireEvent.click(screen.getByRole('switch', { name: 'Saved memories' }))
    await flush()
    expect((await getSettings(getDb(), { memory_enabled: false })).memoryEnabled).toBe(true)
    expect(screen.getByRole('switch', { name: 'Reference earlier chats' })).not.toBeChecked()
    fireEvent.click(screen.getByRole('switch', { name: 'Saved memories' }))
    await flush()
    expect((await getMemoryDocument(getDb())).content).toBe('Keep this document')
    expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'View full memory' })).toBeDisabled()
    expect(screen.getByRole('switch', { name: 'Reference earlier chats' })).toBeEnabled()
  })

  it('disables provider and document controls without losing an open draft, then restores editing', async () => {
    await seed('Saved before disabling')
    mount()
    await flush()
    await enableMemory()
    await startEditing()
    fireEvent.change(editor(), { target: { value: 'Keep this unfinished draft' } })
    fireEvent.click(screen.getByRole('switch', { name: 'Saved memories' }))
    await flush()
    expect(editor()).toHaveValue('Keep this unfinished draft')
    expect(editor()).toBeDisabled()
    for (const name of ['Save', 'Cancel', 'Copy', 'Add connection']) {
      expect(screen.getByRole('button', { name })).toBeDisabled()
    }
    expect(screen.getByRole('radio', { name: 'Built-in' })).toBeDisabled()
    const history = screen.getByRole('switch', { name: 'Reference earlier chats' })
    expect(history).toBeEnabled()
    fireEvent.click(history)
    await flush()
    expect(history).toBeChecked()
    expect((await getMemoryDocument(getDb())).content).toBe('Saved before disabling')
    await enableMemory()
    expect(editor()).toBeEnabled()
    expect(editor()).toHaveValue('Keep this unfinished draft')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await flush()
    expect((await getMemoryDocument(getDb())).content).toBe('Keep this unfinished draft')
  })

  it.each([
    { label: 'Saved memories', key: 'memory_enabled' },
    { label: 'Reference earlier chats', key: 'session_history_enabled' },
  ])('cancels a queued $label toggle after an account change', async ({ label, key }) => {
    mount()
    await flush()
    const pending = Promise.withResolvers<void>()
    const persist = dal.updateSettings
    const write = spyOn(dal, 'updateSettings').mockImplementationOnce(async (...args) => {
      await pending.promise
      await persist(...args)
    })
    try {
      fireEvent.click(screen.getByRole('switch', { name: label }))
      await flush()
      expect(write).toHaveBeenCalledTimes(1)
      invalidateIdentityLifetime()
      pending.resolve()
      await flush()
      expect(await getSettings(getDb(), { [key]: false }, { camelCase: false })).toEqual({ [key]: false })
      expect(screen.queryByRole('alert')).toBeNull()
      fireEvent.click(screen.getByRole('switch', { name: label }))
      await flush()
      expect(await getSettings(getDb(), { [key]: false }, { camelCase: false })).toEqual({ [key]: true })
    } finally {
      pending.resolve()
      write.mockRestore()
    }
  })

  it('reviews compaction, preserves cancellation, and rejects a stale proposal', async () => {
    const before = 'I prefer receiving concise and short answers.'
    await seed(before)
    await createModel(getDb(), { id: 'other', name: 'Another model', model: 'other', provider: 'openai', enabled: 1 })
    await createModel(getDb(), { id: 'rewrite', name: 'Rewrite model', model: 'test', provider: 'openai', enabled: 1 })
    await updateSettings(getDb(), { selected_model: 'rewrite' })
    const pending = Promise.withResolvers<string>()
    const rewrite = spyOn(compaction, 'compactMemories')
      .mockResolvedValue('Prefers concise answers.')
      .mockImplementationOnce(() => pending.promise)
    try {
      mount()
      await flush()
      await enableMemory()
      await viewMemory()
      expect(within(panel()).queryByRole('button', { name: 'Compact' })).toBeNull()
      fireEvent.pointerDown(panelButton('More'), { button: 0 })
      const compactButton = await waitForElement(() => {
        const item = screen.getByRole('menuitem', { name: 'Compact' })
        return item.getAttribute('aria-disabled') === 'true' ? null : item
      })
      fireEvent.click(compactButton)
      await flush()
      expect(rewrite).toHaveBeenCalledWith(
        expect.objectContaining({ model: expect.objectContaining({ id: 'rewrite' }) }),
      )
      fireEvent.pointerDown(panelButton('More'), { button: 0 })
      const compacting = await waitForElement(() => screen.queryByRole('menuitem', { name: 'Compacting…' }))
      expect(compacting).toHaveAttribute('aria-busy', 'true')
      expect(compacting).toHaveAttribute('aria-disabled', 'true')
      fireEvent.keyDown(compacting, { key: 'Escape' })
      expect(within(panel()).queryByRole('button', { name: 'Edit' })).toBeNull()
      pending.resolve('Prefers concise answers.')
      await flush()
      expect(screen.getByRole('dialog')).toHaveTextContent('Prefers concise answers.')
      expect(screen.getByRole('region', { name: 'Current memory' })).toHaveTextContent(before)
      expect(screen.getByRole('region', { name: 'Proposed memory' })).toHaveTextContent('Prefers concise answers.')
      expect((await getMemoryDocument(getDb())).content).toBe(before)
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      await flush()
      expect((await getMemoryDocument(getDb())).content).toBe(before)
      fireEvent.pointerDown(panelButton('More'), { button: 0 })
      fireEvent.click(await waitForElement(() => screen.queryByRole('menuitem', { name: 'Compact' })))
      await flush()
      await saveMemoryDocument(getDb(), 'Prefers detailed answers.', { expectedContent: before })
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
      await flush()
      expect((await getMemoryDocument(getDb())).content).toBe('Prefers detailed answers.')
      expect(screen.getByRole('dialog')).toBeVisible()
    } finally {
      pending.resolve('Prefers concise answers.')
      rewrite.mockRestore()
    }
  })
})
