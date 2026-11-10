/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { beforeAll, describe, expect, it, mock } from 'bun:test'
import * as fsp from '@zenfs/core/promises'
import { runBrowserShell, type ShellWorkerFactory } from './browser-shell-worker.ts'
import { mountInMemoryFs } from './mount.ts'
import { ZenBashFileSystem } from './zen-bash-fs.ts'

const cwd = '/workspace/shell-worker'

beforeAll(async () => {
  await mountInMemoryFs()
  await fsp.mkdir(cwd, { recursive: true })
  await fsp.mkdir('/workspace/shell-worker-sibling', { recursive: true })
  await fsp.writeFile('/workspace/shell-worker-sibling/secret.txt', 'SIBLING SECRET')
})

/** Run a real command worker against the same host filesystem used by the coding tools. */
const execute = (command: string, signal = new AbortController().signal, fs = new ZenBashFileSystem(cwd)) =>
  runBrowserShell({ command, cwd, env: {}, fs, signal })

describe('browser shell worker', () => {
  it('reads and writes the host workspace without copying or remounting it', async () => {
    await fsp.writeFile(`${cwd}/input.txt`, 'héllo from host\n')

    const result = await execute('cat input.txt > output.txt; printf "worker append\\n" >> output.txt; cat output.txt')

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('héllo from host\nworker append\n')
    expect(await fsp.readFile(`${cwd}/output.txt`, { encoding: 'utf8' })).toBe(result.stdout)
  })

  it('preserves binary filesystem content and stat metadata across RPC', async () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255])
    await fsp.writeFile(`${cwd}/binary-input.bin`, bytes)

    const result = await execute(
      'cp binary-input.bin binary-copy.bin; test -f binary-copy.bin && wc -c < binary-copy.bin',
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('5')
    expect(new Uint8Array(await fsp.readFile(`${cwd}/binary-copy.bin`))).toEqual(bytes)
  })

  it('keeps shell filesystem requests inside their conversation workspace', async () => {
    const result = await execute('cat /workspace/shell-worker-sibling/secret.txt')

    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).not.toContain('SIBLING SECRET')
    expect(await fsp.readFile('/workspace/shell-worker-sibling/secret.txt', { encoding: 'utf8' })).toBe(
      'SIBLING SECRET',
    )
  })

  it('keeps host timers responsive and terminates recursive awk when stopped', async () => {
    const controller = new AbortController()
    const reason = new Error('Stopped by the user')
    const started = Promise.withResolvers<void>()
    class ObservedFileSystem extends ZenBashFileSystem {
      override async writeFile(...args: Parameters<ZenBashFileSystem['writeFile']>): Promise<void> {
        await super.writeFile(...args)
        if (args[0].endsWith('/cpu-started')) {
          started.resolve()
        }
      }
    }
    const command =
      "printf started > cpu-started; awk 'function f(n) { if (n > 0) { f(n-1); f(n-1) } } BEGIN { f(24) }'"
    const running = execute(command, controller.signal, new ObservedFileSystem(cwd))
    // Handle rejection before scheduling Stop, without awaiting the running command.
    const stopped = running.catch((error: unknown) => error)
    try {
      await started.promise
      const beforeStop = performance.now()
      await Bun.sleep(30)
      controller.abort(reason)
      expect(await stopped).toBe(reason)
      expect(performance.now() - beforeStop).toBeLessThan(1500)
      expect((await execute('printf recovered')).stdout).toBe('recovered')
    } finally {
      controller.abort(reason)
    }
  })

  it('does not start a worker for an already stopped command', async () => {
    const controller = new AbortController()
    const reason = new Error('Already stopped')
    controller.abort(reason)
    const createWorker = mock<ShellWorkerFactory>(() => {
      throw new Error('An aborted command must not create a worker')
    })

    await expect(
      runBrowserShell({
        command: 'echo unused',
        cwd,
        env: {},
        fs: new ZenBashFileSystem(cwd),
        signal: controller.signal,
        createWorker,
      }),
    ).rejects.toBe(reason)
    expect(createWorker).not.toHaveBeenCalled()
  })

  it('drains an already dispatched write before allowing the next command to start', async () => {
    const controller = new AbortController()
    const reason = new Error('Stopped during a write')
    const started = Promise.withResolvers<void>()
    const releaseWrite = Promise.withResolvers<void>()
    class DelayedFileSystem extends ZenBashFileSystem {
      override async writeFile(...args: Parameters<ZenBashFileSystem['writeFile']>): Promise<void> {
        if (args[0].endsWith('/delayed-write.txt') && args[1].length > 0) {
          started.resolve()
          await releaseWrite.promise
        }
        await super.writeFile(...args)
      }
    }
    let settled = false
    const stopped = execute('printf committed > delayed-write.txt', controller.signal, new DelayedFileSystem(cwd))
      .finally(() => {
        settled = true
      })
      .catch((error: unknown) => error)
    try {
      await started.promise
      controller.abort(reason)
      await Bun.sleep(20)
      expect(settled).toBe(false)
      releaseWrite.resolve()
      expect(await stopped).toBe(reason)
      expect((await execute('cat delayed-write.txt')).stdout).toBe('committed')
    } finally {
      releaseWrite.resolve()
      controller.abort(reason)
    }
  })

  it('surfaces worker failures and terminates the failed worker', async () => {
    const worker = Object.assign(new EventTarget(), {
      postMessage: (_message: unknown) => {
        queueMicrotask(() =>
          worker.dispatchEvent(Object.assign(new Event('error'), { message: 'Worker initialization failed' })),
        )
      },
      terminate: mock(() => undefined),
    })
    const createWorker: ShellWorkerFactory = () => worker

    await expect(
      runBrowserShell({
        command: 'echo unused',
        cwd,
        env: {},
        fs: new ZenBashFileSystem(cwd),
        signal: new AbortController().signal,
        createWorker,
      }),
    ).rejects.toThrow('Worker initialization failed')
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })
})
