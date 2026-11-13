/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ProxyFetchProvider } from '@/lib/proxy-fetch-context'
import { mockProxyFetch } from '@/test-utils/proxy-fetch'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import type { ReactNode } from 'react'
import {
  connectionTestLimits,
  isLocalEndpoint,
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

  it('reports a safe failure without exposing a provider response or authenticated request', async () => {
    // The hook logs failures via console.error; muted so the test output stays clean.
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
    const probe: ConnectionTestProbe = mock(async () => {
      throw Object.assign(new Error('invalid api key: sk-existing'), {
        request: { headers: { Authorization: 'Bearer sk-existing' } },
      })
    })
    const { result } = renderHook(() => useModelConnectionTest(anthropicConfig, probe), { wrapper })

    await act(async () => {
      await result.current.test(anthropicConfig)
    })

    expect(result.current.status).toBe('error')
    expect(result.current.error).toBe(
      'Could not connect to the model. Check your connection and credentials, then try again.',
    )
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('sk-existing')
    expect(errorSpy).toHaveBeenCalledWith('Model connection test failed.')
    errorSpy.mockRestore()
  })

  it('distinguishes a bounded timeout from a provider rejection', async () => {
    const timeout = new AbortController()
    const timeoutSpy = spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { result } = renderHook(() => useModelConnectionTest(anthropicConfig, () => new Promise(() => {})), {
        wrapper,
      })
      await act(async () => {
        const pending = result.current.test(anthropicConfig)
        timeout.abort(new DOMException('Timed out', 'TimeoutError'))
        expect(await pending).toBeNull()
      })
      expect(result.current.isTesting).toBe(false)
      expect(result.current.status).toBe('error')
      expect(result.current.error).toBe('Connection test timed out. Please try again.')
    } finally {
      timeoutSpy.mockRestore()
      errorSpy.mockRestore()
    }
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

describe('isLocalEndpoint', () => {
  it.each([
    ['http://localhost:11434/v1', true],
    ['http://127.0.0.1:1234', true],
    ['http://192.168.1.20:11434', true],
    ['http://[::1]:8080/v1', true],
    ['http://ollama.local:11434', true],
    ['http://host.docker.internal:11434/v1', true],
    ['https://api.example.com/v1', false],
  ])('classifies %s as local: %p', (url, expected) => {
    expect(isLocalEndpoint({ provider: 'custom', url })).toBe(expected)
  })

  it('treats hosted providers and missing urls as remote', () => {
    expect(isLocalEndpoint({ provider: 'openai', url: 'http://localhost:11434' })).toBe(false)
    expect(isLocalEndpoint({ provider: 'custom', url: null })).toBe(false)
  })
})

describe('connectionTestLimits', () => {
  it('waits longer and hints at a model load for local endpoints', () => {
    const local = connectionTestLimits({ provider: 'custom', url: 'http://localhost:11434/v1' })
    const remote = connectionTestLimits({ provider: 'openai', url: null })

    expect(local.timeoutMs).toBeGreaterThan(remote.timeoutMs)
    expect(local.loadingHintAfterMs).not.toBeNull()
    expect(remote.loadingHintAfterMs).toBeNull()
  })
})

describe('useModelConnectionTest loading hint', () => {
  const localConfig: ModelConnectionConfig = {
    provider: 'custom',
    model: 'llama3.2:1b',
    url: 'http://localhost:11434/v1',
    apiKey: null,
  }
  const { loadingHintAfterMs } = connectionTestLimits(localConfig)

  afterEach(() => {
    cleanup()
    mock.restore()
  })

  /** Captures the hook's loading-hint timer so the test can fire it without waiting. */
  const captureLoadingTimer = () => {
    const realSetTimeout = globalThis.setTimeout
    const captured: { fire: (() => void) | null } = { fire: null }
    spyOn(globalThis, 'setTimeout').mockImplementation(((handler: () => void, delay?: number) => {
      if (delay === loadingHintAfterMs) {
        captured.fire = handler
        return 0
      }
      return realSetTimeout(handler, delay)
    }) as typeof setTimeout)
    return captured
  }

  it('flags a slow local test as loading, then clears it on completion', async () => {
    const timer = captureLoadingTimer()
    let resolveInFlight: ((support: ToolSupport) => void) | null = null
    const probe: ConnectionTestProbe = mock(
      () =>
        new Promise<ToolSupport>((resolve) => {
          resolveInFlight = resolve
        }),
    )
    const { result } = renderHook(() => useModelConnectionTest(localConfig, probe), { wrapper })

    let testPromise: Promise<ToolSupport | null> = Promise.resolve(null)
    act(() => {
      testPromise = result.current.test(localConfig)
    })
    expect(result.current.isLoadingModel).toBe(false)

    act(() => timer.fire!())
    expect(result.current.isTesting).toBe(true)
    expect(result.current.isLoadingModel).toBe(true)

    await act(async () => {
      resolveInFlight!('supported')
      await testPromise
    })
    expect(result.current.isLoadingModel).toBe(false)
    expect(result.current.status).toBe('success')
  })

  it('never schedules the loading hint for remote providers', async () => {
    const timer = captureLoadingTimer()
    const probe: ConnectionTestProbe = mock(async () => 'supported' as const)
    const { result } = renderHook(() => useModelConnectionTest(anthropicConfig, probe), { wrapper })

    await act(async () => {
      await result.current.test(anthropicConfig)
    })

    expect(timer.fire).toBeNull()
  })
})
