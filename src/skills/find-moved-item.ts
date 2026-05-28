/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

type Move = { id: string; from: number; to: number }

const arrayMove = <T>(arr: readonly T[], from: number, to: number): T[] => {
  const out = [...arr]
  const [removed] = out.splice(from, 1)
  if (removed === undefined) {
    return out
  }
  out.splice(to, 0, removed)
  return out
}

const sequenceEquals = (a: readonly string[], b: readonly string[]): boolean => {
  if (a.length !== b.length) {
    return false
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false
    }
  }
  return true
}

/**
 * Given an old ordering and a new ordering of the same set of ids,
 * return the single id that moved plus its from/to positions. Returns
 * `null` when the orderings are identical, when lengths disagree, or
 * when more than one id moved (a single-drag reorder should never do
 * the latter; if we see it we'd rather skip telemetry than report a
 * wrong `from`/`to` pair).
 *
 * Drag-down vs drag-up both flow through the same dnd-kit `arrayMove`,
 * but they show up differently at the first-mismatch index — drag-down
 * sees the moved id at `oldIds[firstDiff]`, drag-up sees the *destination*
 * at `newIds[firstDiff]`. We try both candidates and return whichever
 * reconstructs `newIds` exactly.
 *
 * Used by `skill_reordered` telemetry: the chat composer's reorder
 * panel commits an entire `ids[]` array via `reorderPins`, but the
 * telemetry payload wants the moved id alone plus its indices.
 */
export const findMovedItem = (oldIds: readonly string[], newIds: readonly string[]): Move | null => {
  if (oldIds.length !== newIds.length) {
    return null
  }
  let firstDiff = -1
  for (let i = 0; i < oldIds.length; i++) {
    if (oldIds[i] !== newIds[i]) {
      firstDiff = i
      break
    }
  }
  if (firstDiff === -1) {
    return null
  }

  // Forward-move candidate: id at oldIds[firstDiff] moved to its new
  // index in newIds.
  const forwardId = oldIds[firstDiff]
  if (forwardId !== undefined) {
    const forwardTo = newIds.indexOf(forwardId)
    if (forwardTo !== -1) {
      const reconstructed = arrayMove(oldIds, firstDiff, forwardTo)
      if (sequenceEquals(reconstructed, newIds)) {
        return { id: forwardId, from: firstDiff, to: forwardTo }
      }
    }
  }

  // Backward-move candidate: id at newIds[firstDiff] came from an earlier
  // index in oldIds (drag-up case).
  const backwardId = newIds[firstDiff]
  if (backwardId !== undefined) {
    const backwardFrom = oldIds.indexOf(backwardId)
    if (backwardFrom !== -1) {
      const reconstructed = arrayMove(oldIds, backwardFrom, firstDiff)
      if (sequenceEquals(reconstructed, newIds)) {
        return { id: backwardId, from: backwardFrom, to: firstDiff }
      }
    }
  }

  return null
}
