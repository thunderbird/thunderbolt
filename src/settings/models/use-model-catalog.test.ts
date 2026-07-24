/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { catalogToComboboxItems, initialModelCatalogState, modelCatalogReducer } from './use-model-catalog'

describe('modelCatalogReducer', () => {
  it('ignores stale catalog results after a newer request starts', () => {
    const first = modelCatalogReducer(initialModelCatalogState, { type: 'CATALOG_REQUESTED', requestKey: 'first' })
    const second = modelCatalogReducer(first, { type: 'CATALOG_REQUESTED', requestKey: 'second' })
    const stale = modelCatalogReducer(second, {
      type: 'CATALOG_LOADED',
      requestKey: 'first',
      models: [{ id: 'stale', name: 'Stale' }],
    })

    expect(stale).toBe(second)
  })

  it('ignores stale failures the same way', () => {
    const loading = modelCatalogReducer(initialModelCatalogState, { type: 'CATALOG_REQUESTED', requestKey: 'new' })
    expect(modelCatalogReducer(loading, { type: 'CATALOG_FAILED', requestKey: 'old', error: 'boom' })).toBe(loading)
  })

  it('resets everything on invalidation', () => {
    const loaded = modelCatalogReducer(
      { ...initialModelCatalogState, requestKey: 'request', isLoading: true },
      { type: 'CATALOG_LOADED', requestKey: 'request', models: [{ id: 'model', name: 'Model' }] },
    )

    expect(modelCatalogReducer(loaded, { type: 'CATALOG_INVALIDATED' })).toEqual(initialModelCatalogState)
  })
})

describe('catalogToComboboxItems', () => {
  it('labels entries by name with the id as description, falling back to the id', () => {
    expect(catalogToComboboxItems([{ id: 'gpt-4', name: 'GPT-4' }, { id: 'bare-id' }])).toEqual([
      { id: 'gpt-4', label: 'GPT-4', description: 'gpt-4' },
      { id: 'bare-id', label: 'bare-id', description: undefined },
    ])
  })
})
