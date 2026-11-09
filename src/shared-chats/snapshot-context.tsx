/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { ShareSnapshot } from './snapshot'

/** The shared chat a transcript subtree renders. */
export type SharedChatSnapshot = {
  shareId: string
  /** The share's `updatedAt`: replacing a share keeps its id, so this tells its snapshots apart. */
  version: string
  /** Widget data the sharer's message stored, keyed by message id then cache key. */
  cache: ReadonlyMap<string, Record<string, unknown>>
}

const SharedChatSnapshotContext = createContext<SharedChatSnapshot | null>(null)

/**
 * Marks a subtree as rendering a shared chat. Transcript components that would
 * otherwise read or write the local database, or act on a live chat session,
 * check for it: widgets read the copied cache instead, and interactive widgets
 * render read-only.
 */
export const SharedChatSnapshotProvider = ({
  shareId,
  version,
  snapshot,
  children,
}: {
  shareId: string
  version: string
  snapshot: ShareSnapshot
  children: ReactNode
}) => {
  const value = useMemo(
    () => ({
      shareId,
      version,
      cache: new Map(snapshot.messages.flatMap((message) => (message.cache ? [[message.id, message.cache]] : []))),
    }),
    [shareId, version, snapshot],
  )
  return <SharedChatSnapshotContext.Provider value={value}>{children}</SharedChatSnapshotContext.Provider>
}

/** Whether this subtree renders a shared chat rather than a live one. */
export const useIsSharedChat = (): boolean => useContext(SharedChatSnapshotContext) !== null

/** The shared chat being rendered, or null in a normal chat. */
export const useSharedChatSnapshot = () => useContext(SharedChatSnapshotContext)
