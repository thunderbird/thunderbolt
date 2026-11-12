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
        getOpenSession: () => ({
          projectId: currentProject,
          stopping: false,
          retryCount: 0,
          retriesExhausted: false,
          chatInstance: { status },
        }),
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
    const guarded = makeDeps({
      getOpenSession: () => ({
        projectId: null,
        stopping: false,
        retryCount: 0,
        retriesExhausted: false,
        chatInstance: { status },
      }),
    })
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

  it.each([{ retryCount: 1 }, { compactionStatus: 'compacting' as const }])(
    'waits for retry and compaction to finish before a move',
    async (state) => {
      const guarded = makeDeps({
        getOpenSession: () => ({
          projectId: 'p1',
          stopping: false,
          retryCount: 0,
          retriesExhausted: false,
          chatInstance: { status: 'ready' },
          ...state,
        }),
      })
      await expect(moveChatToProject({ chatThreadId: 'chat-1', projectId: 'p2' }, guarded)).rejects.toThrow(
        'Stop the current reply',
      )
      expect(guarded.setProject).not.toHaveBeenCalled()
    },
  )

  it('allows an idle stopped chat to move without lifting automatic-resend suppression', async () => {
    const session = {
      projectId: null,
      stopping: true,
      retryCount: 1,
      retriesExhausted: false,
      chatInstance: { status: 'ready' as const },
    }
    const stopped = makeDeps({ getOpenSession: () => session })
    await moveChatToProject({ chatThreadId: 'chat-1', projectId: 'p2' }, stopped)
    expect(stopped.setProject).toHaveBeenCalledWith(db, 'chat-1', 'p2')
    expect(session.stopping).toBe(true)
  })

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

describe('environment confirmation at the serialized write boundary', () => {
  it('requests confirmation without writing and releases the chat queue while the user decides', async () => {
    const guarded = makeDeps({ getEnvironmentChange: async () => 'sandbox-chat-to-project' })
    await expect(moveChatToProject({ chatThreadId: 'chat-1', projectId: 'p1' }, guarded)).rejects.toMatchObject({
      name: 'ProjectMoveConfirmationRequired',
      environmentChange: 'sandbox-chat-to-project',
    })
    expect(guarded.setProject).not.toHaveBeenCalled()
    expect(await withChatThreadWrite('chat-1', async () => 'queue available')).toBe('queue available')
    await moveChatToProject({ chatThreadId: 'chat-1', projectId: 'p1' }, guarded, 'sandbox-chat-to-project')
    expect(guarded.setProject).toHaveBeenCalledTimes(1)
  })

  it('moves immediately when the effective workspace does not change', async () => {
    const guarded = makeDeps({ getEnvironmentChange: async () => null })
    await moveChatToProject({ chatThreadId: 'chat-1', projectId: 'p1' }, guarded)
    expect(guarded.setProject).toHaveBeenCalledTimes(1)
  })

  it('requires new consent when an environment changes while confirmation is open', async () => {
    const guarded = makeDeps({ getEnvironmentChange: async () => 'new-folder' })
    await expect(
      moveChatToProject({ chatThreadId: 'chat-1', projectId: 'p1' }, guarded, 'previous-folder'),
    ).rejects.toMatchObject({
      name: 'ProjectMoveConfirmationRequired',
      environmentChange: 'new-folder',
    })
    expect(guarded.setProject).not.toHaveBeenCalled()
  })

  it('rejects confirmation if a new agent turn started while the modal was open', async () => {
    const guarded = makeDeps({
      getEnvironmentChange: async () => 'approved-change',
      getOpenSession: () => ({
        projectId: null,
        stopping: false,
        retryCount: 0,
        retriesExhausted: false,
        chatInstance: { status: 'streaming' },
      }),
    })
    await expect(
      moveChatToProject({ chatThreadId: 'chat-1', projectId: 'p1' }, guarded, 'approved-change'),
    ).rejects.toThrow('Stop the current reply')
    expect(guarded.setProject).not.toHaveBeenCalled()
  })
})

it('rechecks active execution after reading the environment declarations', async () => {
  let status: 'ready' | 'streaming' = 'ready'
  const guarded = makeDeps({
    getEnvironmentChange: async () => {
      status = 'streaming'
      return 'approved-change'
    },
    getOpenSession: () => ({
      projectId: null,
      stopping: false,
      retryCount: 0,
      retriesExhausted: false,
      chatInstance: { status },
    }),
  })
  await expect(
    moveChatToProject({ chatThreadId: 'chat-1', projectId: 'p1' }, guarded, 'approved-change'),
  ).rejects.toThrow('Stop the current reply')
  expect(guarded.setProject).not.toHaveBeenCalled()
})
