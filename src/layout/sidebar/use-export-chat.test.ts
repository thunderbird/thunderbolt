/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getDb } from '@/db/database'
import { chatThreadsTable } from '@/db/tables'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { act, renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { useExportChat } from './use-export-chat'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

describe('useExportChat', () => {
  let createObjectUrlSpy: ReturnType<typeof spyOn>
  let revokeObjectUrlSpy: ReturnType<typeof spyOn>
  let appendChildSpy: ReturnType<typeof spyOn>
  let consoleErrorSpy: ReturnType<typeof spyOn>

  beforeEach(async () => {
    await resetTestDatabase()
    createObjectUrlSpy = spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:test/chat')
    revokeObjectUrlSpy = spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    appendChildSpy = spyOn(document.body, 'appendChild')
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    createObjectUrlSpy.mockRestore()
    revokeObjectUrlSpy.mockRestore()
    appendChildSpy.mockRestore()
    consoleErrorSpy.mockRestore()
  })

  const renderExportChat = () => renderHook(() => useExportChat(getDb(), { id: 'user-1', email: 'u1@example.com' }))

  it('saves the chat under its title and reports nothing', async () => {
    await getDb().insert(chatThreadsTable).values({ id: 'thread-1', title: 'Trip plan' })
    const { result } = renderExportChat()

    await act(() => result.current.exportChat('thread-1'))

    const anchor = appendChildSpy.mock.calls
      .map(([node]: [unknown]) => node)
      .find((node: unknown): node is HTMLAnchorElement => node instanceof HTMLAnchorElement)
    expect(anchor?.download).toStartWith('thunderbolt-chat-Trip plan-')
    expect(result.current.errorMessage).toBeNull()
    expect(consoleErrorSpy).not.toHaveBeenCalled()
  })

  it('says the chat could not be read when it is missing, not that saving failed', async () => {
    const { result } = renderExportChat()

    await act(() => result.current.exportChat('missing'))

    expect(result.current.errorMessage).toBe('The chat could not be read on this device.')
    expect(createObjectUrlSpy).not.toHaveBeenCalled()
  })

  it('reports a failed save, and clears the report when dismissed', async () => {
    await getDb().insert(chatThreadsTable).values({ id: 'thread-1', title: 'Trip plan' })
    createObjectUrlSpy.mockImplementation(() => {
      throw new Error('blob refused')
    })
    const { result } = renderExportChat()

    await act(() => result.current.exportChat('thread-1'))
    expect(result.current.errorMessage).toBe('Something went wrong while saving the file.')

    act(() => result.current.dismissError())
    expect(result.current.errorMessage).toBeNull()
  })
})
