/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

type SkillPanelRequestInput =
  | { kind: 'skill'; initialName?: string; skillId?: never }
  | { kind: 'skill'; skillId: string; initialName?: never }

/** The id-less input to `openCreateItem`; the provider assigns the id. */
type CreateItemRequestInput = SkillPanelRequestInput | { kind: 'agent' } | { kind: 'model' }

// Derived from the input so a new kind is added in exactly one place; the
// intersection distributes over the union, keeping `kind` narrowing intact.
export type CreateItemRequest = CreateItemRequestInput & { id: number }

/** Panel titles by kind — one source for both the loaded panels and the
 *  host's Suspense fallback header, so they can never disagree. */
export const createItemTitles: Record<CreateItemRequest['kind'], string> = {
  skill: 'Create Skill',
  agent: 'Add Agent',
  model: 'Add Model',
}

/** Title for the skill panel's edit mode, which the kind map can't express. */
export const editSkillTitle = 'Edit Skill'

/** Returns the route-preserving panel title for create and edit requests. */
export const createItemTitle = (request: CreateItemRequest): string =>
  request.kind === 'skill' && request.skillId ? editSkillTitle : createItemTitles[request.kind]

type CreateItemContextValue = {
  request: CreateItemRequest | null
  isSurfaceOpen: boolean
  openCreateItem: (request: CreateItemRequestInput) => void
  closeCreateItem: () => void
}

const CreateItemContext = createContext<CreateItemContextValue | null>(null)

/**
 * Owns route-independent create requests for app-wide entry points such as
 * the chat's skill, agent, and model selectors.
 */
export const CreateItemProvider = ({ children }: { children: ReactNode }) => {
  const [request, setRequest] = useState<CreateItemRequest | null>(null)
  const [isSurfaceOpen, setIsSurfaceOpen] = useState(false)
  const requestIdCounter = useRef(0)
  const openFrameId = useRef<number | null>(null)

  const openCreateItem = useCallback((nextRequest: CreateItemRequestInput) => {
    if (openFrameId.current !== null) {
      cancelAnimationFrame(openFrameId.current)
    }
    requestIdCounter.current += 1
    setIsSurfaceOpen(false)
    setRequest({ ...nextRequest, id: requestIdCounter.current })
    // Commit the panel once in its closed geometry before changing the open
    // state — a transition cannot run when the panel first mounts already
    // open. Double rAF: the first callback can still coalesce into the same
    // paint as the closed-geometry commit, which would skip the transition.
    openFrameId.current = requestAnimationFrame(() => {
      openFrameId.current = requestAnimationFrame(() => {
        openFrameId.current = null
        setIsSurfaceOpen(true)
      })
    })
  }, [])

  const closeCreateItem = useCallback(() => {
    if (openFrameId.current !== null) {
      cancelAnimationFrame(openFrameId.current)
      openFrameId.current = null
    }
    setIsSurfaceOpen(false)
    setRequest(null)
  }, [])

  useEffect(
    () => () => {
      if (openFrameId.current !== null) {
        cancelAnimationFrame(openFrameId.current)
      }
    },
    [],
  )

  // Memoized so sidebar/layout re-renders don't invalidate every consumer
  // (the chat composer and header both read this context).
  const value = useMemo(
    () => ({ request, isSurfaceOpen, openCreateItem, closeCreateItem }),
    [request, isSurfaceOpen, openCreateItem, closeCreateItem],
  )

  return <CreateItemContext.Provider value={value}>{children}</CreateItemContext.Provider>
}

/** Access the app-wide route-preserving create surface. */
export const useCreateItem = () => {
  const context = useContext(CreateItemContext)
  if (!context) {
    throw new Error('useCreateItem must be used within a CreateItemProvider')
  }
  return context
}
