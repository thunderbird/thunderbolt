/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { act, renderHook, cleanup } from '@testing-library/react'
import { afterEach, expect, it } from 'bun:test'
import { MemoryRouter, useNavigate } from 'react-router'
import type { ReactNode } from 'react'
import { useResourcePageState } from './use-resource-page-state'

afterEach(cleanup)

it('drops a closed editor’s dirty and pending state on browser Back', () => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={['/models', '/models?edit=first']}>{children}</MemoryRouter>
  )
  const { result } = renderHook(() => ({ page: useResourcePageState(), navigate: useNavigate() }), { wrapper })
  act(() => result.current.page.patch({ dirty: true }))
  act(() => result.current.page.requestSelect('second'))
  expect(result.current.page.pendingSelection).toEqual({ id: 'second' })
  act(() => result.current.navigate(-1))
  expect(result.current.page.selectedId).toBeNull()
  expect(result.current.page.dirty).toBe(false)
  expect(result.current.page.pendingSelection).toBeNull()
  act(() => result.current.page.requestSelect('third'))
  expect(result.current.page.selectedId).toBe('third')
  expect(result.current.page.pendingSelection).toBeNull()
})
