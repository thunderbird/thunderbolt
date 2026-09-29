/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')
type RecordRow = {
  kind: string
  timestamp: string
  collector_pid?: number
  reason?: string
  partial_sample?: boolean
  cpu_seconds?: number | null
  query_cpu_seconds?: number | null
  collector_rss_bytes?: number
  output?: string
  status?: string
  error?: string
}

/** Read only complete JSONL records while the collector is running. */
const recordsAt = (path: string): RecordRow[] =>
  existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .slice(0, -1)
        .map((line) => JSON.parse(line))
    : []

/** Wait for a completed sample or a fixture handshake, never a samples counter race. */
const waitFor = async (ready: () => boolean) => {
  const deadline = performance.now() + 3000
  while (!ready()) {
    if (performance.now() >= deadline) {
      throw new Error('collector handshake timed out')
    }
    await Bun.sleep(10)
  }
}

/** Check real process state; launchd may briefly leave an exited orphan as a zombie. */
const isRunning = (pid: number) => {
  const state = Bun.spawnSync(['/bin/ps', '-p', String(pid), '-o', 'stat='])
    .stdout.toString()
    .trim()
  return state !== '' && !state.startsWith('Z')
}

for (const mode of ['normal', 'failure', 'cancel', 'owner', 'timeout', 'invalid-iostat'] as const) {
  test(`collector lifecycle: ${mode}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ios-resources-'))
    const bin = join(directory, 'bin')
    mkdirSync(bin)
    if (mode === 'timeout') {
      writeFileSync(join(bin, 'bun'), '#!/bin/bash\nexec "$BUN_EXEC_PATH" "$RUNNER_TEMP/timeout.ts" "$2" "$3"\n', {
        mode: 0o755,
      })
    } else {
      symlinkSync(process.execPath, join(bin, 'bun'))
    }
    for (const name of [
      'sysctl',
      'sw_vers',
      'xcodebuild',
      'xcrun',
      'maestro',
      'iostat',
      'memory_pressure',
      'vm_stat',
      'df',
      'ps',
    ]) {
      writeFileSync(
        join(bin, name),
        `#!/bin/bash
case "\${0##*/}" in
  iostat)
    if [ "$MODE" = invalid-iostat ]; then echo malformed; exit; fi
    printf 'disk0 cpu load\nKB/t tps MB/s us sy id\n999 999 999 99 1 0\n4 2 1 10 5 85\n';;
  vm_stat)
    if [ "$MODE" = failure ]; then
      { printf 'expected fixture error '; printf 'x%.0s' {1..3000}; } >&2
      exit 9
    fi
    echo 'Pages free: 123';;
  ps)
    case "$MODE" in
      cancel|owner|timeout)
        sleep 60 &
        echo "$!" > "$RUNNER_TEMP/query-child"
        wait;;
      *) echo '100 1 1.0 1234 0:01.00 fixture';;
    esac;;
  *) echo 'fixture metric';;
esac
`,
        { mode: 0o755 },
      )
    }
    // Exercise the same lifecycle with a shorter injected query deadline only in this fixture.
    writeFileSync(
      join(directory, 'timeout.ts'),
      `import { runCollector } from ${JSON.stringify(join(import.meta.dir, 'resources.ts'))};
process.exitCode = await runCollector(process.argv[2], Number(process.argv[3]), 250);
`,
    )
    const originalStatus = mode === 'failure' ? 7 : mode === 'cancel' ? 143 : 0
    const shell = Bun.spawn(
      [
        'bash',
        '-euc',
        `
source e2e/native-smoke/resources.sh
trap 'status=$?; resource_stop "$status" || true; exit "$status"' EXIT
resource_marker smoke_start
while [ ! -f "$RUNNER_TEMP/finish" ]; do sleep 0.05; done
exit "$1"
`,
        'check',
        String(originalStatus),
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          RUNNER_TEMP: directory,
          MODE: mode,
          BUN_EXEC_PATH: process.execPath,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const unrelated = Bun.spawn(['sleep', '60'])
    const metrics = join(directory, 'native-ios-resources/metrics.jsonl')
    try {
      await waitFor(() =>
        mode === 'cancel' || mode === 'owner'
          ? existsSync(join(directory, 'query-child'))
          : recordsAt(metrics).some((row) => row.kind === 'sample_end'),
      )
      if (mode === 'cancel') {
        shell.kill('SIGTERM')
      } else if (mode === 'owner') {
        shell.kill('SIGKILL')
      } else {
        writeFileSync(join(directory, 'finish'), '')
      }
      await shell.exited
      const stdout = await new Response(shell.stdout).text()
      const stderr = await new Response(shell.stderr).text()
      expect(stderr).toBe('')
      if (mode !== 'owner') {
        expect(shell.exitCode).toBe(originalStatus)
      }
      await waitFor(() => recordsAt(metrics).at(-1)?.kind === 'stopped')
      const records = recordsAt(metrics)
      const last = records.at(-1)!
      expect(records.every((row) => row.timestamp.endsWith('Z') && Number.isFinite(Date.parse(row.timestamp)))).toBe(
        true,
      )
      expect(records.some((row) => row.kind === 'sample')).toBe(true)
      expect(last.reason).toBe(mode === 'owner' ? 'owner_exited' : 'signal_15')
      expect(last.partial_sample).toBe(mode === 'cancel' || mode === 'owner')
      expect(Number.isFinite(last.cpu_seconds)).toBe(true)
      expect(last.cpu_seconds).toBeGreaterThanOrEqual(0)
      expect(last.collector_rss_bytes).toBeGreaterThan(1_000_000)
      expect(last.query_cpu_seconds).toBeGreaterThan(0)
      if (mode !== 'invalid-iostat') {
        expect(records.find((row) => row.kind === 'iostat')?.output).not.toContain('999')
      }
      if (mode !== 'owner') {
        expect(stdout.includes('::warning::iOS resource collection incomplete')).toBe(mode !== 'normal')
        expect(readFileSync(join(directory, 'native-ios-resources/phases.tsv'), 'utf8')).toContain(
          `step_exit=${originalStatus}`,
        )
        expect(readFileSync(join(directory, 'native-ios-resources/status.txt'), 'utf8').startsWith('complete')).toBe(
          mode === 'normal',
        )
      }
      if (mode === 'failure') {
        expect(records.find((row) => row.kind === 'vm_stat')?.status).toBe('unavailable')
        const error = records.find((row) => row.kind === 'vm_stat')?.error
        expect(error).toStartWith('exit 9: expected fixture error ')
        expect(error!.length).toBeLessThan(3000)
      }
      if (mode === 'invalid-iostat') {
        expect(records.find((row) => row.kind === 'iostat')?.status).toBe('unavailable')
      }
      if (mode === 'timeout') {
        expect(records.find((row) => row.kind === 'processes')?.error).toBe('timeout')
      }
      await waitFor(() => !isRunning(Number(records[0].collector_pid)))
      if (existsSync(join(directory, 'query-child'))) {
        await waitFor(() => !isRunning(Number(readFileSync(join(directory, 'query-child'), 'utf8'))))
      }
      expect(unrelated.exitCode).toBeNull()
    } finally {
      if (shell.exitCode === null) {
        shell.kill('SIGTERM')
      }
      await shell.exited
      unrelated.kill()
      await unrelated.exited
      rmSync(directory, { recursive: true, force: true })
    }
  })
}

for (const mode of ['directory', 'runtime'] as const) {
  test(`startup failure preserves original status: ${mode}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ios-resource-start-'))
    const bin = join(directory, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'bun'), '#!/bin/bash\nexit 29\n', { mode: 0o755 })
    if (mode === 'directory') {
      writeFileSync(join(directory, 'native-ios-resources'), '')
    }
    try {
      const shell = Bun.spawn(
        [
          'bash',
          '-euc',
          `
source e2e/native-smoke/resources.sh || echo '::warning::Resource collector startup failed'
trap 'status=$?; resource_stop "$status" || true; exit "$status"' EXIT
resource_marker build_start
if [ -n "$resource_pid" ]; then wait "$resource_pid" || true; fi
exit 11
`,
        ],
        {
          cwd: root,
          env: { ...process.env, RUNNER_TEMP: directory, PATH: `${bin}:${process.env.PATH}` },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      const [status, stdout, stderr] = await Promise.all([
        shell.exited,
        new Response(shell.stdout).text(),
        new Response(shell.stderr).text(),
      ])
      expect(status).toBe(11)
      if (mode === 'directory') {
        expect(stdout).toContain('::warning::Resource collector startup failed')
        expect(stdout).toContain('::warning::iOS resource collector did not start')
        expect(stderr).toContain('native-ios-resources')
      } else {
        expect(stdout).toContain('::warning::iOS resource collection incomplete')
        expect(stderr).toBe('')
        expect(readFileSync(join(directory, 'native-ios-resources/status.txt'), 'utf8')).toContain('incomplete')
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
}
