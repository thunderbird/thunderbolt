/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Settings } from '@/config/settings'
import { tinfoilUpstreamOriginStore, type TinfoilUpstreamOriginStore } from './upstream-origin'

const defaultIntervalMs = 60_000
const defaultTimeoutMs = 5_000

export type TinfoilKeepWarmLogger = {
  debug: (context: Record<string, unknown>, message: string) => void
}

type TinfoilKeepWarmOptions = {
  fetchFn?: typeof fetch
  intervalMs?: number
  timeoutMs?: number
  logger: TinfoilKeepWarmLogger
  upstreamOriginStore?: Pick<TinfoilUpstreamOriginStore, 'get'>
}

type TinfoilKeepWarmController = {
  start: () => void
  stop: () => void
}

/**
 * Create a lifecycle controller that keeps Bun's Tinfoil connection pool warm.
 */
export const createTinfoilKeepWarm = (
  settings: Pick<Settings, 'tinfoilApiKey' | 'tinfoilEnclaveUrl'>,
  options: TinfoilKeepWarmOptions,
): TinfoilKeepWarmController => {
  const fetchFn = options.fetchFn ?? globalThis.fetch
  const intervalMs = options.intervalMs ?? defaultIntervalMs
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs
  const upstreamOriginStore = options.upstreamOriginStore ?? tinfoilUpstreamOriginStore
  const defaultEnclaveUrl = settings.tinfoilEnclaveUrl.replace(/\/$/, '')
  const apiPathPrefix = new URL(defaultEnclaveUrl).pathname.replace(/\/$/, '')
  const state: { intervalId?: ReturnType<typeof setInterval> } = {}

  const keepWarm = async () => {
    try {
      const latestOrigin = upstreamOriginStore.get()
      const modelsUrl = `${latestOrigin ? `${latestOrigin}${apiPathPrefix}` : defaultEnclaveUrl}/models`
      const response = await fetchFn(modelsUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${settings.tinfoilApiKey}` },
        signal: AbortSignal.timeout(timeoutMs),
      })
      await response.arrayBuffer()

      if (!response.ok) {
        options.logger.debug(
          { status: response.status },
          'Tinfoil enclave keep-warm request returned a non-success status',
        )
      }
    } catch (error) {
      // Background probe failures must never affect server availability.
      options.logger.debug(
        { errorName: error instanceof Error ? error.name : 'UnknownError' },
        'Tinfoil enclave keep-warm request failed',
      )
    }
  }

  const start = () => {
    if (state.intervalId) {
      return
    }

    if (!settings.tinfoilApiKey) {
      return
    }

    void keepWarm()
    state.intervalId = setInterval(() => void keepWarm(), intervalMs)
  }

  const stop = () => {
    clearInterval(state.intervalId)
    state.intervalId = undefined
  }

  return { start, stop }
}
