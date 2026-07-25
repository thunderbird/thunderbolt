/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react'

export type CreateItemRequest =
  | { id: number; kind: 'skill'; initialName?: string }
  | { id: number; kind: 'agent' }
  | { id: number; kind: 'model' }

export type OpenCreateItemRequest = { kind: 'skill'; initialName?: string } | { kind: 'agent' } | { kind: 'model' }

type CreateItemContextValue = {
  request: CreateItemRequest | null
  surfaceOpen: boolean
  openCreateItem: (request: OpenCreateItemRequest) => void
  closeCreateItem: () => void
}

const CreateItemContext = createContext<CreateItemContextValue | null>(null)

/**
 * Owns route-independent create requests for app-wide entry points such as
 * the chat's skill, agent, and model selectors.
 */
export const CreateItemProvider = ({ children }: { children: ReactNode }) => {
  const [request, setRequest] = useState<CreateItemRequest | null>(null)
  const [surfaceOpen, setSurfaceOpen] = useState(false)
  const nextRequestId = useRef(0)
  const openFrame = useRef<number | null>(null)

  const openCreateItem = useCallback((nextRequest: OpenCreateItemRequest) => {
    if (openFrame.current !== null) {
      cancelAnimationFrame(openFrame.current)
    }
    nextRequestId.current += 1
    setSurfaceOpen(false)
    setRequest({ ...nextRequest, id: nextRequestId.current })
    // Commit the panel once in its closed geometry before changing the open
    // state. A transition cannot run when the panel first mounts already open.
    openFrame.current = requestAnimationFrame(() => {
      openFrame.current = null
      setSurfaceOpen(true)
    })
  }, [])

  const closeCreateItem = useCallback(() => {
    if (openFrame.current !== null) {
      cancelAnimationFrame(openFrame.current)
      openFrame.current = null
    }
    setSurfaceOpen(false)
    setRequest(null)
  }, [])

  useEffect(
    () => () => {
      if (openFrame.current !== null) {
        cancelAnimationFrame(openFrame.current)
      }
    },
    [],
  )

  return (
    <CreateItemContext.Provider value={{ request, surfaceOpen, openCreateItem, closeCreateItem }}>
      {children}
    </CreateItemContext.Provider>
  )
}

/** Access the app-wide route-preserving create surface. */
export const useCreateItem = () => {
  const context = useContext(CreateItemContext)
  if (!context) {
    throw new Error('useCreateItem must be used within a CreateItemProvider')
  }
  return context
}
