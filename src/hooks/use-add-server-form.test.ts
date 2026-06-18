/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { getClock } from '@/testing-library'
import type { FetchFn } from '@/lib/proxy-fetch'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { generateServerName, useAddServerForm, type AddServerFormDeps } from './use-add-server-form'

const fakeFetch = (async () => new Response()) as unknown as FetchFn

/** A 401 shaped like the real transport error `isUnauthorizedError` recognizes. */
const unauthorized = () => Object.assign(new Error('Unauthorized'), { code: 401 })

const makeDeps = (overrides: Partial<AddServerFormDeps> = {}): AddServerFormDeps => ({
  probeMcpServerTools: mock(async () => ['search']) as unknown as AddServerFormDeps['probeMcpServerTools'],
  classifyMcpServerAuth: mock(
    async () => 'authorizable' as const,
  ) as unknown as AddServerFormDeps['classifyMcpServerAuth'],
  buildOAuthFetch: () => fakeFetch,
  ...overrides,
})

const renderForm = (deps: AddServerFormDeps) =>
  renderHook(() => useAddServerForm({ cloudUrl: 'https://cloud.example.com', deps, onClearDialogError: () => {} }))

afterEach(() => {
  cleanup()
})

describe('generateServerName', () => {
  it.each([
    ['https://api.github.com', 'github'],
    ['https://render.com', 'render'],
    ['http://localhost:3000', 'localhost-3000'],
    ['http://192.168.1.100', '192.168.1.100'],
  ] as const)('derives %p → %p', (url, expected) => {
    expect(generateServerName(url)).toBe(expected)
  })
})

describe('useAddServerForm', () => {
  it('derives the name from the URL until the name is manually edited', () => {
    const { result } = renderForm(makeDeps())

    act(() => result.current.changeUrl('https://api.github.com/mcp'))
    expect(result.current.name).toBe('github')

    // A manual name edit pins the value; later URL changes no longer re-derive it.
    act(() => result.current.changeName('custom'))
    act(() => result.current.changeUrl('https://render.com/mcp'))
    expect(result.current.name).toBe('custom')
  })

  it('clears a successful test result when any field is edited', async () => {
    const { result } = renderForm(makeDeps())

    act(() => result.current.openDialog())
    act(() => result.current.changeUrl('https://tools.example.com/mcp'))
    await act(async () => {
      getClock().tick(700)
      await getClock().runAllAsync()
    })
    expect(result.current.testResult.kind).toBe('success')

    // Editing the credential invalidates the result the user just saw.
    act(() => result.current.changeToken('pat-123'))
    expect(result.current.testResult.kind).toBe('idle')
  })

  it('discards an in-flight probe result after the URL field changes', async () => {
    let resolveFirst: (tools: string[]) => void = () => {}
    let call = 0
    const probeMcpServerTools = mock(() => {
      call += 1
      return call === 1 ? new Promise<string[]>((resolve) => (resolveFirst = resolve)) : new Promise<string[]>(() => {})
    }) as unknown as AddServerFormDeps['probeMcpServerTools']
    const { result } = renderForm(makeDeps({ probeMcpServerTools }))

    act(() => result.current.openDialog())
    act(() => result.current.changeUrl('https://a.example.com/mcp'))
    await act(async () => {
      getClock().tick(700)
      await getClock().runAllAsync()
    })
    // Edit the URL before A resolves — this must invalidate A's probe.
    act(() => result.current.changeUrl('https://b.example.com/mcp'))
    await act(async () => {
      resolveFirst(['stale-tool'])
      await getClock().runAllAsync()
    })

    expect(result.current.testResult.kind).not.toBe('success')
    expect(result.current.serverCapabilities).toEqual([])
  })

  it('clears the testing spinner when a field is edited while a probe is in flight', async () => {
    let resolveProbe: (tools: string[]) => void = () => {}
    const probeMcpServerTools = mock(
      () => new Promise<string[]>((resolve) => (resolveProbe = resolve)),
    ) as unknown as AddServerFormDeps['probeMcpServerTools']
    const { result } = renderForm(makeDeps({ probeMcpServerTools }))

    act(() => result.current.openDialog())
    act(() => result.current.changeUrl('https://tools.example.com/mcp'))
    await act(async () => {
      getClock().tick(700)
      await getClock().runAllAsync()
    })
    // The debounced probe is in flight.
    expect(result.current.isTestingConnection).toBe(true)

    // Editing a field mid-probe invalidates it — the spinner (and the disabled
    // "Test Connection" button) must not stay stuck on the invalidated probe.
    act(() => result.current.changeToken('pat-123'))
    expect(result.current.isTestingConnection).toBe(false)
    expect(result.current.testResult.kind).toBe('idle')

    // The invalidated probe settling later must not clobber the reset state.
    await act(async () => {
      resolveProbe(['stale-tool'])
      await getClock().runAllAsync()
    })
    expect(result.current.isTestingConnection).toBe(false)
    expect(result.current.testResult.kind).toBe('idle')
    expect(result.current.serverCapabilities).toEqual([])
  })

  it('does not auto-probe a public http URL the page rejects', async () => {
    const probeMcpServerTools = mock(async () => ['tool']) as unknown as AddServerFormDeps['probeMcpServerTools']
    const { result } = renderForm(makeDeps({ probeMcpServerTools }))

    // Public http:// is rejected by validateMcpServerUrl (https required), so the
    // debounce must respect that policy and not probe a URL the page already gates.
    act(() => result.current.openDialog())
    act(() => result.current.changeUrl('http://public.example.com/mcp'))
    await act(async () => {
      getClock().tick(700)
      await getClock().runAllAsync()
    })

    expect(probeMcpServerTools).not.toHaveBeenCalled()
  })

  it('does not probe on blur for a public http URL the page rejects', async () => {
    const probeMcpServerTools = mock(async () => ['tool']) as unknown as AddServerFormDeps['probeMcpServerTools']
    const { result } = renderForm(makeDeps({ probeMcpServerTools }))

    act(() => result.current.openDialog())
    act(() => result.current.changeUrl('http://public.example.com/mcp'))
    act(() => result.current.handleUrlBlur())
    await act(async () => {
      await getClock().runAllAsync()
    })

    expect(probeMcpServerTools).not.toHaveBeenCalled()
  })

  it('auto-probes a private http URL (localhost) the page allows', async () => {
    const probeMcpServerTools = mock(async () => ['tool']) as unknown as AddServerFormDeps['probeMcpServerTools']
    const { result } = renderForm(makeDeps({ probeMcpServerTools }))

    act(() => result.current.openDialog())
    act(() => result.current.changeUrl('http://localhost:8000/mcp'))
    await act(async () => {
      getClock().tick(700)
      await getClock().runAllAsync()
    })

    expect(probeMcpServerTools).toHaveBeenCalledTimes(1)
  })

  it('does not auto-probe while the dialog is closed', async () => {
    const probeMcpServerTools = mock(async () => ['tool']) as unknown as AddServerFormDeps['probeMcpServerTools']
    const { result } = renderForm(makeDeps({ probeMcpServerTools }))

    // No openDialog() — the debounce is gated on isAddDialogOpen.
    act(() => result.current.changeUrl('https://late.example.com/mcp'))
    await act(async () => {
      getClock().tick(700)
      await getClock().runAllAsync()
    })

    expect(probeMcpServerTools).not.toHaveBeenCalled()
  })

  it('classifies an empty-credential 401 as needs-oauth via discovery', async () => {
    const classifyMcpServerAuth = mock(
      async () => 'authorizable' as const,
    ) as unknown as AddServerFormDeps['classifyMcpServerAuth']
    const probeMcpServerTools = mock(() =>
      Promise.reject(unauthorized()),
    ) as unknown as AddServerFormDeps['probeMcpServerTools']
    const { result } = renderForm(makeDeps({ probeMcpServerTools, classifyMcpServerAuth }))

    act(() => result.current.openDialog())
    act(() => result.current.changeUrl('https://oauth.example.com/mcp'))
    await act(async () => {
      getClock().tick(700)
      await getClock().runAllAsync()
    })

    expect(classifyMcpServerAuth).toHaveBeenCalledTimes(1)
    expect(result.current.testResult.kind).toBe('needs-oauth')
  })

  it('keeps a passing test result when only the name is edited', async () => {
    const { result } = renderForm(makeDeps())

    act(() => result.current.openDialog())
    act(() => result.current.changeUrl('https://tools.example.com/mcp'))
    await act(async () => {
      getClock().tick(700)
      await getClock().runAllAsync()
    })
    expect(result.current.testResult.kind).toBe('success')

    // Renaming doesn't change what the probe verifies, so the success must survive —
    // otherwise Save Changes gets stuck disabled with no obvious recovery.
    act(() => result.current.changeName('My Server'))
    expect(result.current.testResult.kind).toBe('success')
  })

  it('reports hasConnectionEdits only for connection-affecting fields in edit mode', () => {
    const { result } = renderForm(makeDeps())

    act(() =>
      result.current.openEditDialog(
        { id: 's1', name: 'GitHub', url: 'https://api.github.com/mcp', type: 'http', enabled: 1 } as never,
        'tok-1',
      ),
    )
    expect(result.current.hasConnectionEdits).toBe(false)

    // Name is metadata, not part of the probe — must not flip the flag.
    act(() => result.current.changeName('Renamed'))
    expect(result.current.hasConnectionEdits).toBe(false)

    act(() => result.current.changeUrl('https://api.github.com/mcp/v2'))
    expect(result.current.hasConnectionEdits).toBe(true)
  })

  it('hasConnectionEdits is true in Add mode (no original snapshot)', () => {
    const { result } = renderForm(makeDeps())

    act(() => result.current.openDialog())
    // No original to diff against — Add must keep the existing test-success Save gate.
    expect(result.current.hasConnectionEdits).toBe(true)
  })

  it('resets all form state on resetAddDialog', async () => {
    const { result } = renderForm(makeDeps())

    act(() => result.current.openDialog())
    act(() => result.current.changeUrl('https://tools.example.com/mcp'))
    act(() => result.current.changeToken('pat-123'))
    act(() => result.current.resetAddDialog())

    expect(result.current.isAddDialogOpen).toBe(false)
    expect(result.current.url).toBe('')
    expect(result.current.token).toBe('')
    expect(result.current.name).toBe('')
    expect(result.current.testResult.kind).toBe('idle')
  })
})
