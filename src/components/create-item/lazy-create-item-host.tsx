/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { lazy, Suspense, useRef } from 'react'

import { useCreateItem } from './context'

const CreateItemHost = lazy(() => import('./create-item-host').then((module) => ({ default: module.CreateItemHost })))

/**
 * Defers the create-item host (and the detail-panel chrome it imports) out of
 * the entry bundle: the chunk loads on the first quick-create request. Once
 * loaded it stays mounted so the closing panel can animate out.
 */
export const LazyCreateItemHost = () => {
  const { request } = useCreateItem()
  const hasOpenedRef = useRef(false)

  if (request) {
    hasOpenedRef.current = true
  }
  if (!hasOpenedRef.current) {
    return null
  }

  return (
    <Suspense fallback={null}>
      <CreateItemHost />
    </Suspense>
  )
}
