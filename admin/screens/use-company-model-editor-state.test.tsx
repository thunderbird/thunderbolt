/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import { http } from '@/lib/http'
import { createPreviewState, type CompanyModel } from '../data'
import { useCompanyModelEditorState } from './use-company-model-editor-state'

const setup = (model?: CompanyModel) => {
  const state = createPreviewState()
  const dispatch = mock(() => {})
  const onSaved = mock(() => {})
  const onDirtyChange = mock(() => {})
  const preview = { ...state, state, dispatch, companyModels: model ? [model] : [] }
  const hook = renderHook(() => useCompanyModelEditorState({ model, preview, onSaved, onDirtyChange }))
  return { ...hook, dispatch, onSaved, onDirtyChange }
}
afterEach(cleanup)

it('validates custom endpoints locally and never saves credentials or requests a provider catalog', async () => {
  const get = spyOn(http, 'get')
  try {
    const { result, dispatch, onSaved } = setup()
    act(() => result.current.onProviderChange('custom'))
    await act(async () => {
      result.current.form.setValue('name', 'Company endpoint')
      result.current.form.setValue('model', 'team-model')
      result.current.form.setValue('url', 'not-a-url')
      result.current.form.setValue('apiKey', 'test-value-not-for-storage')
      await result.current.form.handleSubmit(result.current.onSubmit)()
    })
    expect(dispatch).not.toHaveBeenCalled()
    expect(result.current.form.getFieldState('url').error).toBeDefined()
    await act(async () => {
      result.current.form.setValue('url', 'http://localhost:11434/v1')
      await result.current.form.handleSubmit(result.current.onSubmit)()
    })
    expect(dispatch).toHaveBeenCalledWith({
      type: 'save-model',
      model: {
        id: expect.any(String),
        name: 'Company endpoint',
        model: 'team-model',
        provider: 'custom',
        url: 'http://localhost:11434/v1',
        enabled: 1,
        deletedAt: null,
      },
    })
    expect(onSaved).toHaveBeenCalledTimes(1)
    expect(get).not.toHaveBeenCalled()
  } finally {
    get.mockRestore()
  }
})

it('keeps identity and disabled state when editing an external provider without credentials', async () => {
  const model: CompanyModel = {
    id: 'existing',
    name: 'Old name',
    provider: 'openai',
    model: 'company-model',
    url: null,
    enabled: 0,
    deletedAt: null,
  }
  const { result, dispatch } = setup(model)
  await act(async () => {
    result.current.form.setValue('name', 'New name')
    await result.current.form.handleSubmit(result.current.onSubmit)()
  })
  expect(dispatch).toHaveBeenCalledWith({ type: 'save-model', model: { ...model, name: 'New name' } })
})
