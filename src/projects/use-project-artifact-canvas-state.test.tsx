/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { act, renderHook } from '@testing-library/react'
import { expect, it } from 'bun:test'
import { useArtifactContextStore } from '@/artifacts/artifact-context-store'
import { useProjectArtifactCanvasState } from './use-project-artifact-canvas-state'

it('yields context to an overlay, restores the canvas, and clears it on departure', () => {
  const { result, rerender, unmount } = renderHook(
    ({ active }) => useProjectArtifactCanvasState('<h1>Chart</h1>', 'Chart', active),
    { initialProps: { active: true } },
  )
  act(() => result.current.onContextChange({ title: 'Chart', summary: 'Seven bars' }))
  expect(useArtifactContextStore.getState().context?.summary).toBe('Seven bars')
  rerender({ active: false })
  useArtifactContextStore.getState().openArtifact('Overlay')
  act(() => result.current.onContextChange({ title: 'Chart', summary: 'Eight bars' }))
  expect(useArtifactContextStore.getState().title).toBe('Overlay')
  expect(useArtifactContextStore.getState().context).toBeNull()
  rerender({ active: true })
  expect(useArtifactContextStore.getState().title).toBe('Chart')
  expect(useArtifactContextStore.getState().context?.summary).toBe('Eight bars')
  unmount()
  expect(useArtifactContextStore.getState().title).toBeNull()
})

it('keeps runtime errors visible until the artifact document changes', () => {
  const { result, rerender } = renderHook(({ html }) => useProjectArtifactCanvasState(html, 'Chart', true), {
    initialProps: { html: '<p>Old</p>' },
  })
  act(() => result.current.onError('Runtime failure'))
  act(() => result.current.onContextChange({ title: 'Chart', summary: 'Old' }))
  expect(result.current.error).toBe('Runtime failure')
  rerender({ html: '<p>New</p>' })
  expect(result.current.error).toBeNull()
  expect(useArtifactContextStore.getState().context).toBeNull()
})
