/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { editModelFormReducer, initialEditModelFormState } from './use-edit-model-form-state'

describe('editModelFormReducer', () => {
  it('ignores stale catalog results after a newer request starts', () => {
    const first = editModelFormReducer(initialEditModelFormState, {
      type: 'catalog-loading',
      requestKey: 'first',
    })
    const second = editModelFormReducer(first, {
      type: 'catalog-loading',
      requestKey: 'second',
    })
    const stale = editModelFormReducer(second, {
      type: 'catalog-loaded',
      requestKey: 'first',
      models: [{ id: 'stale', name: 'Stale' }],
    })

    expect(stale).toBe(second)
  })

  it('invalidates catalog data when connection fields change', () => {
    const loaded = editModelFormReducer(
      { ...initialEditModelFormState, catalogRequestKey: 'request', isLoadingCatalog: true },
      {
        type: 'catalog-loaded',
        requestKey: 'request',
        models: [{ id: 'model', name: 'Model' }],
      },
    )

    expect(editModelFormReducer(loaded, { type: 'catalog-invalidated' })).toMatchObject({
      availableModels: [],
      catalogRequestKey: null,
      isLoadingCatalog: false,
      catalogError: null,
    })
  })
})
