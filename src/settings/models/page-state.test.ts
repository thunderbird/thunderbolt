/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { initialModelsPageState, modelsPageReducer } from './page-state'

describe('modelsPageReducer', () => {
  it('represents add, detail, and edit as one panel state', () => {
    const detail = modelsPageReducer(initialModelsPageState, {
      type: 'PANEL_CHANGED',
      panel: { kind: 'detail', modelId: 'model-1' },
    })
    const edit = modelsPageReducer(detail, {
      type: 'PANEL_CHANGED',
      panel: { kind: 'edit', modelId: 'model-1' },
    })
    expect(edit.panel).toEqual({ kind: 'edit', modelId: 'model-1' })
    expect(modelsPageReducer(edit, { type: 'PANEL_CHANGED', panel: null }).panel).toBeNull()
  })

  it('clears a stale mutation error when the panel or delete confirmation changes', () => {
    const failed = modelsPageReducer(initialModelsPageState, { type: 'MUTATION_FAILED', error: 'Failed to add.' })
    expect(failed.mutationError).toBe('Failed to add.')

    expect(modelsPageReducer(failed, { type: 'PANEL_CHANGED', panel: null }).mutationError).toBeNull()
    expect(modelsPageReducer(failed, { type: 'DELETE_REQUESTED', modelId: 'model-1' }).mutationError).toBeNull()
    expect(modelsPageReducer(failed, { type: 'DELETE_DISMISSED' }).mutationError).toBeNull()
    expect(modelsPageReducer(failed, { type: 'MUTATION_STARTED' }).mutationError).toBeNull()
  })
})
