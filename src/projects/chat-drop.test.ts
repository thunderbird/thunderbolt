/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { chatDragId, chatIdFromDragId, projectDropId, resolveChatDrop, unassignDropId } from './chat-drop'

describe('drag id encoding', () => {
  it('round-trips a chat id', () => {
    expect(chatIdFromDragId(chatDragId('chat-1'))).toBe('chat-1')
  })

  it('rejects ids that are not chat drags', () => {
    expect(chatIdFromDragId(projectDropId('p1'))).toBeNull()
    expect(chatIdFromDragId('task-7')).toBeNull()
  })

  it('survives ids containing the delimiter', () => {
    expect(chatIdFromDragId(chatDragId('weird:id:1'))).toBe('weird:id:1')
  })
})

describe('resolveChatDrop', () => {
  it('assigns a chat to the project it was dropped on', () => {
    expect(resolveChatDrop(chatDragId('chat-1'), projectDropId('proj-1'))).toEqual({
      chatThreadId: 'chat-1',
      projectId: 'proj-1',
    })
  })

  it('clears the project on the unassign target', () => {
    expect(resolveChatDrop(chatDragId('chat-1'), unassignDropId)).toEqual({
      chatThreadId: 'chat-1',
      projectId: null,
    })
  })

  it('ignores a drop outside any target', () => {
    expect(resolveChatDrop(chatDragId('chat-1'), null)).toBeNull()
    expect(resolveChatDrop(chatDragId('chat-1'), undefined)).toBeNull()
  })

  it('ignores a chat dropped on something that is not a project', () => {
    expect(resolveChatDrop(chatDragId('chat-1'), 'task-3')).toBeNull()
  })

  it('ignores a draggable that is not a chat', () => {
    expect(resolveChatDrop('task-3', projectDropId('proj-1'))).toBeNull()
  })

  it('accepts numeric dnd-kit ids without crashing', () => {
    expect(resolveChatDrop(7, 9)).toBeNull()
  })
})
