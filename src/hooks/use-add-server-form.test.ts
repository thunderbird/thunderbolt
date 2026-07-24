/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { getClock } from '@/testing-library'
import type { FetchFn } from '@/lib/proxy-fetch'
import type { McpServer } from '@/types'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { generateServerName, useAddServerForm, type AddServerFormDeps } from './use-add-server-form'

const fakeFetch = (async () => new Response()) as unknown as FetchFn

/** A 401 shaped like the real transport error `isUnauthorizedError` recognizes. */
const unauthorized = () => Object.assign(new Error('Unauthorized'), { code: 401 })

/** Build a fully-typed McpServer for edit-dialog tests without an `as never` escape hatch. */
const makeMcpServer = (overrides: Partial<McpServer> = {}): McpServer => ({
  id: 's1',
  name: 'default',
  type: 'http',
  enabled: 1,
  url: null,
  command: null,
  args: null,
  createdAt: null,
  updatedAt: null,
  deletedAt: null,
  userId: null,
  ...overrides,
})

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

    act(() => result.current.openAddForm())
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

    act(() => result.current.openAddForm())
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

    act(() => result.current.openAddForm())
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
    act(() => result.current.openAddForm())
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

    act(() => result.current.openAddForm())
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

    act(() => result.current.openAddForm())
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

    // No openAddForm() — the debounce is gated on isAddFormOpen.
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

    act(() => result.current.openAddForm())
    act(() => result.current.changeUrl('https://oauth.example.com/mcp'))
    await act(async () => {
      getClock().tick(700)
      await getClock().runAllAsync()
    })

    expect(classifyMcpServerAuth).toHaveBeenCalledTimes(1)
    expect(result.current.testResult.kind).toBe('needs-oauth')
  })

  it('detects an iroh NodeId/ticket and derives transport: iroh', () => {
    const { result } = renderForm(makeDeps())

    expect(result.current.isIroh).toBe(false)
    expect(result.current.transport).toBe('http')

    act(() => result.current.changeUrl('a'.repeat(52)))
    expect(result.current.isIroh).toBe(true)
    expect(result.current.transport).toBe('iroh')
  })

  it('reverts to the selected http/sse transport when the iroh target is cleared', () => {
    const { result } = renderForm(makeDeps())

    act(() => result.current.changeTransport('sse'))
    act(() => result.current.changeUrl('a'.repeat(52)))
    expect(result.current.transport).toBe('iroh')

    act(() => result.current.changeUrl(''))
    expect(result.current.isIroh).toBe(false)
    expect(result.current.transport).toBe('sse')
  })

  it('does not auto-probe an iroh target (it is not a URL)', async () => {
    const probeMcpServerTools = mock(async () => ['tool']) as unknown as AddServerFormDeps['probeMcpServerTools']
    const { result } = renderForm(makeDeps({ probeMcpServerTools }))

    act(() => result.current.openAddForm())
    act(() => result.current.changeUrl('a'.repeat(52)))
    act(() => result.current.handleUrlBlur())
    await act(async () => {
      getClock().tick(700)
      await getClock().runAllAsync()
    })

    expect(probeMcpServerTools).not.toHaveBeenCalled()
  })

  it('keeps a passing test result when only the name is edited', async () => {
    const { result } = renderForm(makeDeps())

    act(() => result.current.openAddForm())
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
      result.current.openEditForm(
        makeMcpServer({ id: 's1', name: 'GitHub', url: 'https://api.github.com/mcp', type: 'http', enabled: 1 }),
        'tok-1',
        'bearer',
      ),
    )
    expect(result.current.hasConnectionEdits).toBe(false)

    // Name is metadata, not part of the probe — must not flip the flag.
    act(() => result.current.changeName('Renamed'))
    expect(result.current.hasConnectionEdits).toBe(false)

    act(() => result.current.changeUrl('https://api.github.com/mcp/v2'))
    expect(result.current.hasConnectionEdits).toBe(true)
  })

  it('reports isClearingBearerOnly only when a stored bearer is cleared with URL/transport untouched', () => {
    const { result } = renderForm(makeDeps())

    // Bearer-authorized server: the token stays out of the input; the form
    // only knows a stored bearer exists.
    act(() =>
      result.current.openEditForm(
        makeMcpServer({ id: 's1', name: 'GitHub', url: 'https://api.github.com/mcp', type: 'http', enabled: 1 }),
        'tok-1',
        'bearer',
      ),
    )
    expect(result.current.hasStoredBearerToken).toBe(true)
    expect(result.current.isClearingBearerOnly).toBe(false)

    // Clearing the stored bearer flips it — the Save gate must recognize this
    // so removing auth from a still-protected server doesn't get stuck disabled.
    act(() => result.current.toggleClearStoredToken())
    expect(result.current.hasConnectionEdits).toBe(true)
    expect(result.current.isClearingBearerOnly).toBe(true)

    // Also changing the URL is no longer a bearer-only clear — it's a real edit.
    act(() => result.current.changeUrl('https://api.github.com/mcp/v2'))
    expect(result.current.isClearingBearerOnly).toBe(false)
  })

  it('does not report isClearingBearerOnly when the original credential was OAuth or none', () => {
    const { result } = renderForm(makeDeps())

    act(() =>
      result.current.openEditForm(
        makeMcpServer({ id: 's2', name: 'GitHub', url: 'https://api.github.com/mcp', type: 'http', enabled: 1 }),
        null,
        'oauth',
      ),
    )
    // OAuth is managed via the Authorize buttons, not the token field, so a
    // blank token here has always been the state — nothing to "clear".
    expect(result.current.isClearingBearerOnly).toBe(false)
  })

  it('reports isOAuthEdit for an OAuth-authorized server until the user types a bearer token', () => {
    const { result } = renderForm(makeDeps())

    // Open Edit on an OAuth server — the token field is deliberately empty
    // (OAuth credentials aren't surfaced in the token input).
    act(() =>
      result.current.openEditForm(
        makeMcpServer({ id: 'oauth-1', name: 'GH', url: 'https://api.github.com/mcp', type: 'http', enabled: 1 }),
        null,
        'oauth',
      ),
    )
    expect(result.current.isOAuthEdit).toBe(true)

    // A URL edit doesn't affect the flag — the server is still OAuth-with-empty-token.
    act(() => result.current.changeUrl('https://api.github.com/mcp/v2'))
    expect(result.current.isOAuthEdit).toBe(true)

    // Typing a bearer converts the intent away from OAuth (mutation will replace
    // OAuth credential with bearer), so the probe becomes actionable again.
    act(() => result.current.changeToken('pat-123'))
    expect(result.current.isOAuthEdit).toBe(false)
  })

  it('does not report isOAuthEdit for bearer or none-credential servers in Edit mode', () => {
    const { result } = renderForm(makeDeps())

    act(() =>
      result.current.openEditForm(
        makeMcpServer({ id: 'bearer-1', name: 'GH', url: 'https://api.github.com/mcp', type: 'http', enabled: 1 }),
        'tok-1',
        'bearer',
      ),
    )
    // Bearer server, even after clearing the token — bearer is not OAuth.
    expect(result.current.isOAuthEdit).toBe(false)
    act(() => result.current.changeToken(''))
    expect(result.current.isOAuthEdit).toBe(false)
  })

  it('does not report isOAuthEdit in Add mode (no original snapshot)', () => {
    const { result } = renderForm(makeDeps())
    act(() => result.current.openAddForm())
    expect(result.current.isOAuthEdit).toBe(false)
  })

  it('skips the auto-probe when opening Edit on an OAuth server (empty token stays empty)', async () => {
    const probeMcpServerTools = mock(async () => ['tool']) as unknown as AddServerFormDeps['probeMcpServerTools']
    const { result } = renderForm(makeDeps({ probeMcpServerTools }))

    act(() =>
      result.current.openEditForm(
        makeMcpServer({ id: 'oauth-1', name: 'GH', url: 'https://api.github.com/mcp', type: 'http', enabled: 1 }),
        null,
        'oauth',
      ),
    )
    // Advance past the debounce — the probe would fire here for a bearer/none
    // server, but must not for an OAuth server with an empty token (the 401 would
    // render a misleading "needs authorization" panel over an already-connected
    // server, and burn a network round-trip on every Edit-open).
    await act(async () => {
      getClock().tick(1000)
      await getClock().runAllAsync()
    })
    expect(probeMcpServerTools).not.toHaveBeenCalled()
    expect(result.current.testResult.kind).toBe('idle')
  })

  it('probes once the user types a bearer on an OAuth-server edit (converts away from OAuth)', async () => {
    const probeMcpServerTools = mock(async () => ['tool']) as unknown as AddServerFormDeps['probeMcpServerTools']
    const { result } = renderForm(makeDeps({ probeMcpServerTools }))

    act(() =>
      result.current.openEditForm(
        makeMcpServer({ id: 'oauth-1', name: 'GH', url: 'https://api.github.com/mcp', type: 'http', enabled: 1 }),
        null,
        'oauth',
      ),
    )
    // Typing a bearer lifts the OAuth-skip guard: the probe can now succeed and
    // is the confirmation the user needs before Save Changes unlocks.
    act(() => result.current.changeToken('pat-123'))
    await act(async () => {
      getClock().tick(700)
      await getClock().runAllAsync()
    })
    expect(probeMcpServerTools).toHaveBeenCalledTimes(1)
    expect(result.current.testResult.kind).toBe('success')
  })

  it('hasConnectionEdits is true in Add mode (no original snapshot)', () => {
    const { result } = renderForm(makeDeps())

    act(() => result.current.openAddForm())
    // No original to diff against — Add must keep the existing test-success Save gate.
    expect(result.current.hasConnectionEdits).toBe(true)
  })

  it('resets all form state on resetAddForm', async () => {
    const { result } = renderForm(makeDeps())

    act(() => result.current.openAddForm())
    act(() => result.current.changeUrl('https://tools.example.com/mcp'))
    act(() => result.current.changeToken('pat-123'))
    act(() => result.current.resetAddForm())

    expect(result.current.isAddFormOpen).toBe(false)
    expect(result.current.url).toBe('')
    expect(result.current.token).toBe('')
    expect(result.current.name).toBe('')
    expect(result.current.testResult.kind).toBe('idle')
  })
})
