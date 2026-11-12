/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

type SkillPanelRequestInput =
  | { kind: 'skill'; initialName?: string; skillId?: never }
  | { kind: 'skill'; skillId: string; initialName?: never }

/** The id-less input to `openCreateItem`; the provider assigns the id. */
type CreateItemRequestInput =
  | SkillPanelRequestInput
  | { kind: 'agent' }
  | { kind: 'model' }
  | { kind: 'memory'; initialEditContent?: string }
  | {
      kind: 'connection'
      connectionId?: string
      mcpServerId?: string
      memoryOnly?: boolean
      action?: 'edit' | 'remove'
    }

// Derived from the input so a new kind is added in exactly one place; the
// intersection distributes over the union, keeping `kind` narrowing intact.
export type CreateItemRequest = CreateItemRequestInput & { id: number }

/** Panel titles by kind — one source for both the loaded panels and the
 *  host's Suspense fallback header, so they can never disagree. */
export const createItemTitles: Record<CreateItemRequest['kind'], MessageDescriptor> = {
  skill: msg`Create Skill`,
  agent: msg`Add Agent`,
  model: msg`Add Model`,
  connection: msg`New Connection`,
  memory: msg`Built-in memory`,
}

/** Title for the skill panel's edit mode, which the kind map can't express. */
export const editSkillTitle = msg`Edit Skill`

/** Returns the route-preserving panel title for create and edit requests. */
export const createItemTitle = (request: CreateItemRequest): MessageDescriptor =>
  request.kind === 'skill' && request.skillId ? editSkillTitle : createItemTitles[request.kind]

type CreateItemContextValue = {
  request: CreateItemRequest | null
  isSurfaceOpen: boolean
  openCreateItem: (request: CreateItemRequestInput) => void
  closeCreateItem: (requestId?: number) => void
}

const CreateItemContext = createContext<CreateItemContextValue | null>(null)

type CreateItemState = {
  pathname: string | undefined
  request: CreateItemRequest | null
  isSurfaceOpen: boolean
}

/**
 * Opens create panels in place, with drafts owned by the page that opened them.
 * Changing pages clears the panel without remounting the surrounding layout.
 */
export const CreateItemProvider = ({ children, pathname }: { children: ReactNode; pathname?: string }) => {
  const [state, setState] = useState<CreateItemState>({ pathname, request: null, isSurfaceOpen: false })
  const requestIdCounter = useRef(0)
  const openFrameId = useRef<number | null>(null)

  if (state.pathname !== pathname) {
    setState({ pathname, request: null, isSurfaceOpen: false })
  }

  const openCreateItem = useCallback(
    (nextRequest: CreateItemRequestInput) => {
      if (openFrameId.current !== null) {
        cancelAnimationFrame(openFrameId.current)
      }
      const id = ++requestIdCounter.current
      setState({ pathname, request: { ...nextRequest, id }, isSurfaceOpen: false })
      // Commit the panel once in its closed geometry before changing the open
      // state — a transition cannot run when the panel first mounts already
      // open. Double rAF: the first callback can still coalesce into the same
      // paint as the closed-geometry commit, which would skip the transition.
      openFrameId.current = requestAnimationFrame(() => {
        openFrameId.current = requestAnimationFrame(() => {
          openFrameId.current = null
          // Navigation can retire the request while its opening frames are queued.
          setState((current) => (current.request?.id === id ? { ...current, isSurfaceOpen: true } : current))
        })
      })
    },
    [pathname],
  )

  const closeCreateItem = useCallback((requestId?: number) => {
    setState((current) => {
      // A save from a retired panel must not dismiss the panel opened after it.
      if (requestId !== undefined && current.request?.id !== requestId) {
        return current
      }
      return { ...current, request: null, isSurfaceOpen: false }
    })
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
  const { request, isSurfaceOpen } = state
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
