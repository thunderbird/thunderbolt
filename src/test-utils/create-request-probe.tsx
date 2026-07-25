/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLocation } from 'react-router'

import { useCreateItem } from '@/components/create-item/context'

/**
 * Test probe rendering the current route and the pending create-item request
 * as `pathname|kind`, so tests can assert a quick-create entry point opened
 * the surface without changing routes. Render inside a `CreateItemProvider`
 * and a router.
 */
export const CreateRequestProbe = () => {
  const { request } = useCreateItem()
  const location = useLocation()
  return <div data-testid="create-request">{`${location.pathname}|${request?.kind ?? ''}`}</div>
}
