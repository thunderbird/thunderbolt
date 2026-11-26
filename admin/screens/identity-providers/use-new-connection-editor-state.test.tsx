/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import type { PanelDirt } from '../../components/use-resource-page-state'
import { useNewConnectionEditorState } from './use-new-connection-editor-state'

const setup = () => {
  const onDirty = mock((_dirty: PanelDirt) => {})
  const { result } = renderHook(() => useNewConnectionEditorState(onDirty))
  return { result, onDirty }
}

afterEach(cleanup)

describe('useNewConnectionEditorState', () => {
  it('starts on the picker and opens the picked kind', () => {
    const { result } = setup()
    expect(result.current.kind).toBeNull()
    act(() => result.current.pick('saml'))
    expect(result.current.kind).toBe('saml')
  })

  it('forwards dirtiness to the parent', () => {
    const { result, onDirty } = setup()
    act(() => result.current.pick('scim'))
    act(() => result.current.trackDirty('secret'))
    expect(onDirty).toHaveBeenLastCalledWith('secret')
  })

  it('goes straight back to the picker from a clean form', () => {
    const { result, onDirty } = setup()
    act(() => result.current.pick('oidc'))
    act(() => result.current.requestBack())
    expect(result.current.kind).toBeNull()
    expect(result.current.confirmingBack).toBe(false)
    expect(onDirty).toHaveBeenLastCalledWith(false)
  })

  it('asks before leaving a dirty form, and stays when the prompt is dismissed', () => {
    const { result } = setup()
    act(() => result.current.pick('oidc'))
    act(() => result.current.trackDirty(true))
    act(() => result.current.requestBack())
    expect(result.current.confirmingBack).toBe(true)
    expect(result.current.kind).toBe('oidc')
    act(() => result.current.cancelBack())
    expect(result.current.confirmingBack).toBe(false)
    expect(result.current.kind).toBe('oidc')
  })

  it('confirming the prompt returns to the picker clean', () => {
    const { result, onDirty } = setup()
    act(() => result.current.pick('oidc'))
    act(() => result.current.trackDirty(true))
    act(() => result.current.requestBack())
    act(() => result.current.confirmBack())
    expect(result.current.kind).toBeNull()
    expect(result.current.confirmingBack).toBe(false)
    expect(onDirty).toHaveBeenLastCalledWith(false)
    act(() => result.current.pick('saml'))
    act(() => result.current.requestBack())
    expect(result.current.kind).toBeNull()
  })
})
