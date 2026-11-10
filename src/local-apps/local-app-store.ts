/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { LocalApp, LocalAppOwner } from '@shared/local-app-protocol'

type LocalAppStore = {
  apps: Record<string, LocalApp>
  save: (app: LocalApp) => void
  remove: (id: string) => void
}

/** Launch recipes contain native paths and must never enter the synced database. */
export const useLocalAppStore = create<LocalAppStore>()(
  persist(
    (set) => ({
      apps: {},
      save: (app) => set((state) => ({ apps: { ...state.apps, [app.id]: app } })),
      remove: (id) =>
        set((state) => {
          const app = state.apps[id]
          return app ? { apps: { ...state.apps, [id]: { ...app, deletedAt: new Date().toISOString() } } } : state
        }),
    }),
    { name: 'thunderbolt-local-apps-v1', partialize: (state) => ({ apps: state.apps }) },
  ),
)

/** Look up a live recipe without exposing deleted entries. */
export const getLocalApp = (id: string): LocalApp | undefined => {
  const app = useLocalAppStore.getState().apps[id]
  return app?.deletedAt ? undefined : app
}

/** Return only this project's or standalone chat's device-local apps. */
export const listLocalApps = (owner: LocalAppOwner): LocalApp[] =>
  Object.values(useLocalAppStore.getState().apps).filter(
    (app) => !app.deletedAt && app.owner.kind === owner.kind && app.owner.id === owner.id,
  )
