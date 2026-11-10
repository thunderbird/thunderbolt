/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { withChatThreadWrite } from '@/chats/chat-thread-write'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { moveChatToProject, type MoveChatDeps } from './use-move-chat-to-project'

const db = {} as AnyDrizzleDatabase

const makeDeps = (overrides: Partial<MoveChatDeps> = {}) => ({
  db,
  getOpenSession: () => undefined,
  setProject: mock(async () => true),
  updateOpenSession: mock(() => {}),
  refreshChatList: mock(async () => {}),
  ...overrides,
})

let deps: ReturnType<typeof makeDeps>

beforeEach(() => {
  deps = makeDeps()
})

describe('moveChatToProject', () => {
  it('clears a chat’s project when given null', async () => {
    await moveChatToProject({ chatThreadId: 'chat-1', projectId: null }, deps)

    expect(deps.setProject).toHaveBeenCalledWith(db, 'chat-1', null)
    expect(deps.updateOpenSession).toHaveBeenCalledWith('chat-1', null)
  })

  it('writes membership and updates the open chat’s badge', async () => {
    await moveChatToProject({ chatThreadId: 'chat-1', projectId: 'p1' }, deps)

    expect(deps.setProject).toHaveBeenCalledWith(db, 'chat-1', 'p1')
    expect(deps.updateOpenSession).toHaveBeenCalledWith('chat-1', 'p1')
    expect(deps.refreshChatList).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['submitted', null, 'p1'],
    ['streaming', 'p1', null],
    ['streaming', 'p1', 'p2'],
  ] as const)(
    'refuses an active %s chat move from %s to %s without cancelling or writing',
    async (status, currentProject, nextProject) => {
      const blocked = makeDeps({
        getOpenSession: () => ({ projectId: currentProject, stopping: false, chatInstance: { status } }),
      })
      await expect(moveChatToProject({ chatThreadId: 'chat-1', projectId: nextProject }, blocked)).rejects.toThrow(
        'Stop the current reply',
      )
      expect(blocked.setProject).not.toHaveBeenCalled()
      expect(blocked.updateOpenSession).not.toHaveBeenCalled()
      expect(blocked.refreshChatList).not.toHaveBeenCalled()
    },
  )

  it('checks again when a queued move reaches the write boundary and allows retry after the turn stops', async () => {
    const previous = Promise.withResolvers<void>()
    const writing = withChatThreadWrite('chat-1', () => previous.promise)
    let status: 'ready' | 'streaming' = 'ready'
    const guarded = makeDeps({ getOpenSession: () => ({ projectId: null, stopping: false, chatInstance: { status } }) })
    const move = moveChatToProject({ chatThreadId: 'chat-1', projectId: 'p1' }, guarded)
    status = 'streaming'
    previous.resolve()
    await writing
    await expect(move).rejects.toThrow('Stop the current reply')
    expect(guarded.setProject).not.toHaveBeenCalled()
    status = 'ready'
    await moveChatToProject({ chatThreadId: 'chat-1', projectId: 'p1' }, guarded)
    expect(guarded.setProject).toHaveBeenCalledTimes(1)
  })

  it.each([{ stopping: true }, { compactionStatus: 'compacting' as const }])(
    'waits for stopping and compaction to finish before a move',
    async (state) => {
      const guarded = makeDeps({
        getOpenSession: () => ({ projectId: 'p1', stopping: false, chatInstance: { status: 'ready' }, ...state }),
      })
      await expect(moveChatToProject({ chatThreadId: 'chat-1', projectId: 'p2' }, guarded)).rejects.toThrow(
        'Stop the current reply',
      )
      expect(guarded.setProject).not.toHaveBeenCalled()
    },
  )

  it('keeps the live session unchanged when the target project disappeared', async () => {
    const rejected = makeDeps({ setProject: mock(async () => false) })
    await moveChatToProject({ chatThreadId: 'chat-1', projectId: 'deleted' }, rejected)
    expect(rejected.updateOpenSession).not.toHaveBeenCalled()
  })

  it('does not swallow a failure to write membership itself', async () => {
    // The opposite of the above: if the move did not happen, the caller must hear
    // about it rather than the UI claiming success.
    const failing = makeDeps({
      setProject: mock(async () => {
        throw new Error('database is gone')
      }),
    })

    await expect(moveChatToProject({ chatThreadId: 'chat-1', projectId: 'p1' }, failing)).rejects.toThrow(
      'database is gone',
    )
    expect(failing.updateOpenSession).not.toHaveBeenCalled()
    // A failed write must release the chat's queue for a subsequent move.
    await moveChatToProject({ chatThreadId: 'chat-1', projectId: 'p2' }, deps)
    expect(deps.updateOpenSession).toHaveBeenCalledWith('chat-1', 'p2')
  })
})
