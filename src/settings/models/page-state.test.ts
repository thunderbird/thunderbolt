/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { initialModelsPageState, modelsPageReducer } from './page-state'

describe('modelsPageReducer', () => {
  it('represents add, detail, and edit as one panel state', () => {
    const detail = modelsPageReducer(initialModelsPageState, {
      type: 'open-panel',
      panel: { kind: 'detail', modelId: 'model-1' },
    })
    const edit = modelsPageReducer(detail, {
      type: 'open-panel',
      panel: { kind: 'edit', modelId: 'model-1' },
    })
    expect(edit.panel).toEqual({ kind: 'edit', modelId: 'model-1' })
    expect(modelsPageReducer(edit, { type: 'open-panel', panel: null }).panel).toBeNull()
  })

  it('discards a catalog response for stale request inputs', () => {
    const loading = modelsPageReducer(initialModelsPageState, { type: 'catalog-loading', requestKey: 'new' })
    expect(
      modelsPageReducer(loading, {
        type: 'catalog-loaded',
        requestKey: 'old',
        models: [{ id: 'stale' }],
      }),
    ).toEqual(loading)
  })
})
