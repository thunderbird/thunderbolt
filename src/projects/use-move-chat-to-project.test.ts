/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it, mock } from 'bun:test'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { moveChatToProject, type MoveChatDeps } from './use-move-chat-to-project'

const db = {} as AnyDrizzleDatabase

const makeDeps = (overrides: Partial<MoveChatDeps> = {}) => ({
  db,
  setProject: mock(async () => {}),
  absorb: mock(async () => ({})),
  updateOpenSession: mock(() => {}),
  refreshChatList: mock(async () => {}),
  ...overrides,
})

let deps: ReturnType<typeof makeDeps>

beforeEach(() => {
  deps = makeDeps()
})

describe('moveChatToProject', () => {
  it('writes membership and updates the open chat’s badge', async () => {
    await moveChatToProject({ chatThreadId: 'chat-1', projectId: 'p1' }, deps)

    expect(deps.setProject).toHaveBeenCalledWith(db, 'chat-1', 'p1')
    expect(deps.updateOpenSession).toHaveBeenCalledWith('chat-1', 'p1')
    expect(deps.refreshChatList).toHaveBeenCalledTimes(1)
  })

  it('back-fills the project’s knowledge with the chat’s documents', async () => {
    await moveChatToProject({ chatThreadId: 'chat-1', projectId: 'p1' }, deps)
    expect(deps.absorb).toHaveBeenCalledWith(db, 'p1', 'chat-1')
  })

  it('still updates the badge and list when the knowledge back-fill fails', async () => {
    // The reported symptom: a drop highlighted its target and then appeared to do
    // nothing. Membership is written first, so a throw from absorption used to
    // skip the updates below — the row had changed but the UI had not.
    const failing = makeDeps({
      absorb: mock(async () => {
        throw new Error('a document could not be read')
      }),
    })

    await moveChatToProject({ chatThreadId: 'chat-1', projectId: 'p1' }, failing)

    expect(failing.updateOpenSession).toHaveBeenCalledWith('chat-1', 'p1')
    expect(failing.refreshChatList).toHaveBeenCalledTimes(1)
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
  })

  it('skips absorption when clearing a chat’s project', async () => {
    await moveChatToProject({ chatThreadId: 'chat-1', projectId: null }, deps)

    expect(deps.setProject).toHaveBeenCalledWith(db, 'chat-1', null)
    expect(deps.absorb).not.toHaveBeenCalled()
    expect(deps.updateOpenSession).toHaveBeenCalledWith('chat-1', null)
  })
})
