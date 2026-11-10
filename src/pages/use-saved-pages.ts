/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useSyncExternalStore } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useQuery } from '@powersync/tanstack-react-query'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import type { PageChrome, PageDefinition } from '@shared/page-protocol'
import { useDatabase } from '@/contexts/database-context'
import { localSavedPagesStore } from './local-saved-pages'
import { getSavedPagesQuery, removeSavedPage, savedPagesFromRows, savePage } from './saved-pages'
import { sortSavedPages } from './saved-page'

/** One sidebar list combines synced website/HTML shortcuts with this device's local apps. */
export const useSavedPages = () => {
  const db = useDatabase()
  const query = useQuery({ queryKey: ['savedPages'], query: toCompilableQuery(getSavedPagesQuery(db)) })
  const local = useSyncExternalStore(localSavedPagesStore.subscribe, localSavedPagesStore.getSnapshot)
  return {
    pages: sortSavedPages([...savedPagesFromRows(query.data ?? []), ...local]),
    loading: query.isLoading,
    error: query.error,
  }
}

/** Share pin and unpin behavior across tabs, inline artifacts and the side menu. */
export const useSavePage = () => {
  const db = useDatabase()
  const save = useMutation({
    mutationKey: ['savePage'],
    mutationFn: ({ page, chrome }: { page: PageDefinition; chrome: PageChrome }) => savePage(db, page, chrome),
  })
  const remove = useMutation({ mutationKey: ['removeSavedPage'], mutationFn: (id: string) => removeSavedPage(db, id) })
  return {
    save: save.mutateAsync,
    remove: remove.mutateAsync,
    isPending: save.isPending || remove.isPending,
    error: save.error ?? remove.error,
  }
}
