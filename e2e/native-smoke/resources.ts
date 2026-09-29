/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { closeSync, openSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

type Query = readonly [metric: string, command: string[]]
const baseline: Query[] = [
  ['hardware', ['sysctl', 'hw.model', 'hw.ncpu', 'hw.memsize', 'machdep.cpu.brand_string']],
  ['macos', ['sw_vers']],
  ['xcode', ['xcodebuild', '-version']],
  ['ios_runtimes', ['xcrun', 'simctl', 'list', 'runtimes']],
  ['maestro', ['maestro', '--version']],
]
const queries: Query[] = [
  ['iostat', ['iostat', '-d', '-C', '-U', '-n', '8', '-w', '1', '-c', '2']],
  ['memory_pressure', ['memory_pressure', '-Q']],
  ['pressure_level', ['sysctl', 'kern.memorystatus_vm_pressure_level']],
  ['vm_stat', ['vm_stat']],
  ['swap', ['sysctl', 'vm.swapusage']],
  ['disk_free', ['df', '-k', '.']],
  ['processes', ['ps', '-A', '-c', '-o', 'pid=,ppid=,pcpu=,rss=,time=,comm=']],
]

/** Kill only a query's private session, including descendants holding its output pipe. */
const killQuery = (pid: number) => {
  try {
    process.kill(-pid, 'SIGKILL')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw error
    }
  }
}

/** Collect read-only macOS metrics until signalled or orphaned; the deadline is injectable for tests. */
export const runCollector = async (directory: string, owner: number, queryTimeoutMs = 15_000) => {
  const stream = openSync(join(directory, 'metrics.jsonl'), 'a')
  const started = performance.now()
  const stop = new AbortController()
  const { signal } = stop
  const terminate = () => stop.abort('signal_15')
  const interrupt = () => stop.abort('signal_2')
  process.on('SIGTERM', terminate)
  process.on('SIGINT', interrupt)
  const ownerWatch = setInterval(() => {
    if (process.ppid !== owner) {
      stop.abort('owner_exited')
    }
  }, 250)
  let errors = 0
  let samples = 0
  let partialSample = false
  let previous: number | undefined
  let queryCpuSeconds: number | null = 0

  /** Write each record immediately, retaining completed observations on cancellation. */
  const emit = (kind: string, values: Record<string, string | number | boolean | null>) => {
    writeSync(stream, `${JSON.stringify({ timestamp: new Date().toISOString(), kind, ...values })}\n`)
  }

  /** Account for Bun's microsecond CPU counters; current RSS is bytes, not peak RSS. */
  const usage = () => {
    const own = process.cpuUsage()
    const collectorCpuSeconds = (own.user + own.system) / 1_000_000
    return {
      cpu_seconds: queryCpuSeconds === null ? null : collectorCpuSeconds + queryCpuSeconds,
      collector_cpu_seconds: collectorCpuSeconds,
      query_cpu_seconds: queryCpuSeconds,
      collector_rss_bytes: process.memoryUsage().rss,
    }
  }

  /** Bound a query and record failures without changing the build/smoke result. */
  const collect = async ([metric, command]: Query) => {
    signal.throwIfAborted()
    const start = performance.now()
    try {
      const child = Bun.spawn(command, { detached: true, stdout: 'pipe', stderr: 'ignore' })
      const abort = () => killQuery(child.pid)
      let timedOut = false
      const timeout = setTimeout(() => {
        timedOut = true
        abort()
      }, queryTimeoutMs)
      signal.addEventListener('abort', abort, { once: true })
      try {
        const output = new Response(child.stdout).text()
        const code = await child.exited
        killQuery(child.pid)
        const stdout = (await output).trim()
        const resource = child.resourceUsage()
        const cpuSeconds = resource ? Number(resource.cpuTime.total) / 1_000_000 : null
        queryCpuSeconds = queryCpuSeconds === null || cpuSeconds === null ? null : queryCpuSeconds + cpuSeconds
        if (signal.aborted) {
          throw new Error(String(signal.reason))
        }
        if (timedOut) {
          throw new Error('timeout')
        }
        if (code !== 0) {
          throw new Error(`exit ${code}`)
        }
        if (!stdout) {
          throw new Error('empty output')
        }
        const lines = stdout.split('\n')
        if (metric === 'iostat' && lines.length !== 4) {
          throw new Error('unexpected iostat format; interval sample unavailable')
        }
        emit(metric, {
          status: 'available',
          duration_seconds: (performance.now() - start) / 1000,
          output: metric === 'iostat' ? [...lines.slice(0, 2), lines[3]].join('\n') : stdout,
        })
      } finally {
        clearTimeout(timeout)
        signal.removeEventListener('abort', abort)
        killQuery(child.pid)
        await child.exited
      }
    } catch (error) {
      errors += 1
      emit(metric, {
        status: 'unavailable',
        duration_seconds: (performance.now() - start) / 1000,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  try {
    emit('identity', {
      collector_pid: process.pid,
      owner_pid: owner,
      bun_version: Bun.version,
      image_os: process.env.ImageOS ?? 'unavailable',
      image_version: process.env.ImageVersion ?? 'unavailable',
      simulator_udid: process.env.IOS_SIMULATOR_UDID ?? 'unavailable',
    })
    if (process.ppid !== owner) {
      stop.abort('owner_exited')
    }
    for (const query of baseline) {
      await collect(query)
    }
    while (!signal.aborted) {
      partialSample = true
      const sampleStart = performance.now()
      emit('sample', { index: samples, gap_seconds: previous === undefined ? null : (sampleStart - previous) / 1000 })
      previous = sampleStart
      for (const query of queries) {
        await collect(query)
      }
      signal.throwIfAborted()
      emit('sample_end', { index: samples, ...usage() })
      samples += 1
      partialSample = false
      await delay(Math.max(0, 5000 - (performance.now() - sampleStart)), undefined, { signal })
    }
  } catch (error) {
    if (!signal.aborted) {
      throw error
    }
  } finally {
    clearInterval(ownerWatch)
    process.off('SIGTERM', terminate)
    process.off('SIGINT', interrupt)
    try {
      emit('stopped', {
        reason: String(signal.reason ?? 'unexpected_exit'),
        samples,
        unavailable: errors,
        partial_sample: partialSample,
        elapsed_seconds: (performance.now() - started) / 1000,
        ...usage(),
      })
    } finally {
      closeSync(stream)
    }
  }
  return Number(errors > 0 || samples === 0 || signal.reason !== 'signal_15')
}

if (import.meta.main) {
  const [directory, owner] = process.argv.slice(2)
  if (!directory || !Number.isSafeInteger(Number(owner)) || Number(owner) <= 1) {
    throw new Error('Usage: bun resources.ts <directory> <owner-pid>')
  }
  process.exitCode = await runCollector(directory, Number(owner))
}
