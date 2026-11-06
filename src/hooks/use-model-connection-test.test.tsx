/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ProxyFetchProvider } from '@/lib/proxy-fetch-context'
import { mockProxyFetch } from '@/test-utils/proxy-fetch'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import type { ReactNode } from 'react'
import {
  useModelConnectionTest,
  type ConnectionTestProbe,
  type ModelConnectionConfig,
  type ToolSupport,
} from './use-model-connection-test'

const wrapper = ({ children }: { children: ReactNode }) => (
  <ProxyFetchProvider proxyFetch={mockProxyFetch}>{children}</ProxyFetchProvider>
)

const anthropicConfig: ModelConnectionConfig = {
  provider: 'anthropic',
  model: 'claude-3-5-sonnet-20241022',
  url: null,
  apiKey: 'sk-existing',
}

describe('useModelConnectionTest', () => {
  afterEach(() => {
    cleanup()
  })

  it('starts idle with no error', () => {
    const { result } = renderHook(() => useModelConnectionTest(anthropicConfig), { wrapper })

    expect(result.current.status).toBe('idle')
    expect(result.current.isTesting).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('surfaces success when the probe resolves for the current credentials', async () => {
    const probe: ConnectionTestProbe = mock(async () => 'supported' as const)
    const { result } = renderHook(() => useModelConnectionTest(anthropicConfig, probe), { wrapper })

    await act(async () => {
      await result.current.test(anthropicConfig)
    })

    expect(result.current.status).toBe('success')
    expect(result.current.isTesting).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('surfaces error with the probe failure message', async () => {
    // The hook logs failures via console.error; muted so the test output stays clean.
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
    const probe: ConnectionTestProbe = mock(async () => {
      throw new Error('invalid api key')
    })
    const { result } = renderHook(() => useModelConnectionTest(anthropicConfig, probe), { wrapper })

    await act(async () => {
      await result.current.test(anthropicConfig)
    })

    expect(result.current.status).toBe('error')
    expect(result.current.error).toBe('invalid api key')
    errorSpy.mockRestore()
  })

  it('collapses status to idle when current credentials diverge from the tested ones', async () => {
    const probe: ConnectionTestProbe = mock(async () => 'supported' as const)
    const { result, rerender } = renderHook(
      ({ config }: { config: ModelConnectionConfig }) => useModelConnectionTest(config, probe),
      { wrapper, initialProps: { config: anthropicConfig } },
    )

    await act(async () => {
      await result.current.test(anthropicConfig)
    })
    expect(result.current.status).toBe('success')

    rerender({ config: { ...anthropicConfig, apiKey: 'sk-different' } })

    expect(result.current.status).toBe('idle')
    expect(result.current.error).toBeNull()
  })

  it('treats empty and null credentials as equivalent when matching the tested config', async () => {
    const probe: ConnectionTestProbe = mock(async () => 'supported' as const)
    const initial: ModelConnectionConfig = { ...anthropicConfig, url: '', apiKey: 'sk-abc' }
    const { result, rerender } = renderHook(
      ({ config }: { config: ModelConnectionConfig }) => useModelConnectionTest(config, probe),
      { wrapper, initialProps: { config: initial } },
    )

    await act(async () => {
      await result.current.test(initial)
    })
    expect(result.current.status).toBe('success')

    // Flipping url from '' → null (the shape callers commonly pass through)
    // must NOT invalidate the tested config.
    rerender({ config: { ...initial, url: null } })

    expect(result.current.status).toBe('success')
  })

  it('reset clears status and the stored tested config', async () => {
    const probe: ConnectionTestProbe = mock(async () => 'supported' as const)
    const { result } = renderHook(() => useModelConnectionTest(anthropicConfig, probe), { wrapper })

    await act(async () => {
      await result.current.test(anthropicConfig)
    })
    expect(result.current.status).toBe('success')

    act(() => {
      result.current.reset()
    })

    expect(result.current.status).toBe('idle')
    expect(result.current.error).toBeNull()
  })

  it('collapses isTesting to false when credentials diverge mid-flight', async () => {
    let resolveInFlight: ((support: ToolSupport) => void) | null = null
    const probe: ConnectionTestProbe = mock(
      () =>
        new Promise<ToolSupport>((resolve) => {
          resolveInFlight = resolve
        }),
    )
    const { result, rerender } = renderHook(
      ({ config }: { config: ModelConnectionConfig }) => useModelConnectionTest(config, probe),
      { wrapper, initialProps: { config: anthropicConfig } },
    )

    let testPromise: Promise<ToolSupport | null> = Promise.resolve(null)
    act(() => {
      testPromise = result.current.test(anthropicConfig)
    })
    expect(result.current.isTesting).toBe(true)

    // Edit credentials mid-flight — spinner must snap off without waiting for the probe.
    rerender({ config: { ...anthropicConfig, apiKey: 'sk-different' } })
    expect(result.current.isTesting).toBe(false)

    await act(async () => {
      resolveInFlight!('supported')
      await testPromise
    })
  })

  it('ignores probe completions from superseded runs', async () => {
    let resolveInFlight: ((support: ToolSupport) => void) | null = null
    const probe: ConnectionTestProbe = mock(
      () =>
        new Promise<ToolSupport>((resolve) => {
          resolveInFlight = resolve
        }),
    )
    const { result } = renderHook(() => useModelConnectionTest(anthropicConfig, probe), { wrapper })

    // Fire the test but do not await — the probe hangs until we call resolveInFlight().
    let testPromise: Promise<ToolSupport | null> = Promise.resolve(null)
    act(() => {
      testPromise = result.current.test(anthropicConfig)
    })
    expect(result.current.isTesting).toBe(true)

    // Reset while the probe is still in flight — bumps the runId.
    act(() => {
      result.current.reset()
    })
    expect(result.current.isTesting).toBe(false)

    // Now let the probe resolve — the guarded dispatch must skip.
    await act(async () => {
      resolveInFlight!('supported')
      await testPromise
    })

    expect(result.current.status).toBe('idle')
    expect(result.current.isTesting).toBe(false)
  })

  it('exposes and returns the tool-support verdict for the current config', async () => {
    const probe: ConnectionTestProbe = mock(async () => 'unsupported' as const)
    const { result, rerender } = renderHook(
      ({ config }: { config: ModelConnectionConfig }) => useModelConnectionTest(config, probe),
      { wrapper, initialProps: { config: anthropicConfig } },
    )

    let verdict: ToolSupport | null = null
    await act(async () => {
      verdict = await result.current.test(anthropicConfig)
    })

    expect(verdict).toBe('unsupported')
    expect(result.current.toolSupport).toBe('unsupported')

    rerender({ config: { ...anthropicConfig, model: 'another-model' } })
    expect(result.current.toolSupport).toBeNull()
  })

  it('returns no verdict for a superseded run', async () => {
    let resolveInFlight: ((support: ToolSupport) => void) | null = null
    const probe: ConnectionTestProbe = mock(
      () =>
        new Promise<ToolSupport>((resolve) => {
          resolveInFlight = resolve
        }),
    )
    const { result } = renderHook(() => useModelConnectionTest(anthropicConfig, probe), { wrapper })

    let testPromise: Promise<ToolSupport | null> = Promise.resolve(null)
    act(() => {
      testPromise = result.current.test(anthropicConfig)
    })
    act(() => {
      result.current.reset()
    })

    let verdict: ToolSupport | null = 'supported'
    await act(async () => {
      resolveInFlight!('unsupported')
      verdict = await testPromise
    })

    expect(verdict).toBeNull()
  })

  it('returns no verdict when the config was edited while the test ran', async () => {
    let resolveInFlight: ((support: ToolSupport) => void) | null = null
    const probe: ConnectionTestProbe = mock(
      () =>
        new Promise<ToolSupport>((resolve) => {
          resolveInFlight = resolve
        }),
    )
    const { result, rerender } = renderHook(
      ({ config }: { config: ModelConnectionConfig }) => useModelConnectionTest(config, probe),
      { wrapper, initialProps: { config: anthropicConfig } },
    )

    let testPromise: Promise<ToolSupport | null> = Promise.resolve(null)
    act(() => {
      testPromise = result.current.test(anthropicConfig)
    })
    rerender({ config: { ...anthropicConfig, model: 'another-model' } })

    let verdict: ToolSupport | null = 'supported'
    await act(async () => {
      resolveInFlight!('unsupported')
      verdict = await testPromise
    })

    expect(verdict).toBeNull()
  })
})
