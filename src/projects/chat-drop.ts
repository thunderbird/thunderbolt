/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Drag-and-drop identity for "drop a chat onto a project".
 *
 * dnd-kit identifies draggables and droppables by a flat id namespace, and the
 * sidebar already contains other sortables. Prefixing keeps the two kinds of id
 * distinguishable, so a chat can never be mistaken for a project (or for a
 * task row) when a drop is resolved — and so resolution stays a pure function
 * that can be unit-tested without a DOM.
 */

const chatPrefix = 'chat-drag:'
const projectPrefix = 'project-drop:'
/** Drop target that clears a chat's project instead of assigning one. */
export const unassignDropId = 'project-drop:__none__'

/** Data attached to a chat draggable, so a drop can be judged without a DB read. */
export type ChatDragData = {
  title: string | null
  /** Project the chat is already in, or null. Drives whether the unassign
   *  target is offered at all — you can't remove a chat from nothing. */
  projectId: string | null
}

/** dnd-kit id for a draggable chat row. */
export const chatDragId = (chatThreadId: string): string => `${chatPrefix}${chatThreadId}`

/** dnd-kit id for a droppable project row. */
export const projectDropId = (projectId: string): string => `${projectPrefix}${projectId}`

/** The chat a drag id refers to, or null when it isn't a chat drag. */
export const chatIdFromDragId = (dragId: string): string | null =>
  dragId.startsWith(chatPrefix) ? dragId.slice(chatPrefix.length) : null

export type ChatDrop = {
  chatThreadId: string
  /** Target project, or null when dropped on the unassign target. */
  projectId: string | null
}

/**
 * Resolve a dnd-kit drag end into the move to perform, or null when the gesture
 * shouldn't change anything: dropped outside any target, a non-chat draggable, or
 * a chat dropped onto something that isn't a project.
 */
export const resolveChatDrop = (
  activeId: string | number,
  overId: string | number | null | undefined,
): ChatDrop | null => {
  const chatThreadId = chatIdFromDragId(String(activeId))
  if (!chatThreadId || overId === null || overId === undefined) {
    return null
  }
  const over = String(overId)
  if (over === unassignDropId) {
    return { chatThreadId, projectId: null }
  }
  if (!over.startsWith(projectPrefix)) {
    return null
  }
  return { chatThreadId, projectId: over.slice(projectPrefix.length) }
}
