/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const python = process.env.DEMO_PYTHON ?? 'python3'
const directory = mkdtempSync(join(tmpdir(), 'thunder-demo-test-'))
const source = join(directory, 'source.mp4')
const editor = join(import.meta.dir, 'demo.py')
const recorder = join(import.meta.dir, 'cli.py')
const recipePath = join(directory, 'recipe.json')

/** Execute helpers with bounded runtime and expose real stderr on failure. */
const run = (command: string[]) => Bun.spawnSync(command, { timeout: 20000 })

/** Write a small recipe whose meaningful invariants can be checked after export. */
const writeRecipe = (keep: number[][], crop = { x: 8, y: 8, width: 144, height: 84 }) => {
  writeFileSync(
    recipePath,
    JSON.stringify({
      version: 1,
      clips: [
        {
          id: 'test',
          source: 'source.mp4',
          output: 'out.mp4',
          poster: 'out.webp',
          keep,
          crop,
          outputWidth: 144,
          posterAt: 1,
        },
      ],
    }),
  )
}

const editCommand = [
  python,
  editor,
  'edit',
  recipePath,
  '--source-dir',
  directory,
  '--output-dir',
  directory,
  '--report',
  join(directory, 'report.json'),
]

/** A rejection must be our validation error, not a missing dependency or timeout. */
const expectValidationError = (result: ReturnType<typeof run>, message: string) => {
  expect(result.exitCode, result.stderr.toString()).toBe(1)
  expect(result.stderr.toString()).toContain(`ValueError: ${message}`)
}

beforeAll(() => {
  const dependencies = run([python, '-c', 'import PIL'])
  expect(dependencies.exitCode, dependencies.stderr.toString()).toBe(0)
  const result = run([
    'ffmpeg',
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=160x100:rate=30',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440',
    '-t',
    '4',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    source,
  ])
  expect(result.exitCode, result.stderr.toString()).toBe(0)
})

afterAll(() => rmSync(directory, { recursive: true, force: true }))

test('exports selected intervals, strips audio, preserves master, and derives a WebP poster', () => {
  const originalHash = createHash('sha256').update(readFileSync(source)).digest('hex')
  writeRecipe([
    [0.2, 1.2],
    [2.2, 3.2],
  ])
  const result = run(editCommand)
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  const [report] = JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8'))
  expect(report.duration).toBeGreaterThanOrEqual(1.95)
  expect(report.duration).toBeLessThanOrEqual(2.1)
  expect(report.audio).toBe(false)
  expect(report.codec).toBe('h264')
  expect(report.width).toBe(144)
  expect(report.height).toBe(84)
  expect(report.sourceSha256).toBe(originalHash)
  expect(createHash('sha256').update(readFileSync(source)).digest('hex')).toBe(originalHash)
  const poster = readFileSync(join(directory, 'out.webp'))
  expect(poster.subarray(0, 4).toString()).toBe('RIFF')
  expect(poster.subarray(8, 12).toString()).toBe('WEBP')
  expect(run([python, editor, 'check', join(directory, 'out.mp4')]).exitCode).toBe(0)
})

test.each([
  {
    keep: [
      [1, 3],
      [2, 4],
    ],
  },
  { keep: [[-1, 2]] },
  { keep: [[1, 9]] },
  { keep: [[2, 1]] },
])('rejects invalid cuts before replacing a website asset: %j', ({ keep }) => {
  writeFileSync(join(directory, 'out.mp4'), 'existing website asset')
  const before = createHash('sha256')
    .update(readFileSync(join(directory, 'out.mp4')))
    .digest('hex')
  writeRecipe(keep)
  expectValidationError(run(editCommand), 'Keep ranges must be ordered, non-overlapping, and within the source')
  expect(
    createHash('sha256')
      .update(readFileSync(join(directory, 'out.mp4')))
      .digest('hex'),
  ).toBe(before)
})

test('rejects a crop outside the recorded window', () => {
  writeRecipe([[0, 2]], { x: 20, y: 0, width: 160, height: 100 })
  expectValidationError(run(editCommand), 'Crop/overlay rectangle lies outside the source')
})

test('rejects a batch that would overwrite another clip’s raw source', () => {
  const before = createHash('sha256').update(readFileSync(source)).digest('hex')
  writeFileSync(
    recipePath,
    JSON.stringify({
      version: 1,
      clips: [
        { id: 'first', source: 'source.mp4', keep: [[0, 2]], output: 'other-source.mp4', poster: 'first.webp' },
        { id: 'second', source: 'other-source.mp4', keep: [[0, 2]], output: 'second.mp4', poster: 'second.webp' },
      ],
    }),
  )
  expectValidationError(run(editCommand), 'Outputs must be unique and cannot overwrite any raw source in the batch')
  expect(createHash('sha256').update(readFileSync(source)).digest('hex')).toBe(before)
})

test('PTY capture preserves real stdout, stderr, and a failing command exit', () => {
  const cast = join(directory, 'real.cast.json')
  const result = run([
    python,
    recorder,
    'record',
    '--cwd',
    directory,
    '--output',
    cast,
    '--',
    python,
    '-c',
    'import sys; print("real stdout"); print("real stderr",file=sys.stderr); sys.exit(7)',
  ])
  expect(result.exitCode).toBe(7)
  const recording = JSON.parse(readFileSync(cast, 'utf8'))
  expect(recording.exit).toBe(7)
  expect(
    recording.events
      .slice(1)
      .map((event: [number, string]) => event[1])
      .join(''),
  ).toContain('real stdout')
  expect(
    recording.events
      .slice(1)
      .map((event: [number, string]) => event[1])
      .join(''),
  ).toContain('real stderr')
  expect(recording.timedOut).toBe(false)
})

test('a later invalid clip leaves all existing assets and their provenance intact', () => {
  const previous = ['first.mp4', 'first.webp', 'second.mp4', 'second.webp', 'report.json']
  for (const name of previous) writeFileSync(join(directory, name), `previous ${name}`)
  writeFileSync(
    recipePath,
    JSON.stringify({
      version: 1,
      clips: [
        { id: 'first', source: 'source.mp4', keep: [[0, 1]], output: 'first.mp4', poster: 'first.webp' },
        { id: 'second', source: 'source.mp4', keep: [[3, 9]], output: 'second.mp4', poster: 'second.webp' },
      ],
    }),
  )
  expectValidationError(run(editCommand), 'Keep ranges must be ordered, non-overlapping, and within the source')
  for (const name of previous) expect(readFileSync(join(directory, name), 'utf8')).toBe(`previous ${name}`)
})

test('recipe boundary and transactional file invariants', () => {
  const result = run([python, join(import.meta.dir, 'demo_helpers_test.py')])
  expect(result.exitCode, result.stderr.toString()).toBe(0)
})

test('a single-clip edit still protects every raw source in the recipe', () => {
  writeFileSync(
    recipePath,
    JSON.stringify({
      version: 1,
      clips: [
        { id: 'first', source: 'source.mp4', keep: [[0, 1]], output: 'other.mp4', poster: 'first.webp' },
        { id: 'other', source: 'other.mp4', keep: [[0, 1]], output: 'second.mp4', poster: 'second.webp' },
      ],
    }),
  )
  expectValidationError(
    run([...editCommand, '--only', 'first']),
    'Outputs must be unique and cannot overwrite any raw source in the batch',
  )
})

test('provenance cannot replace the edit recipe', () => {
  writeRecipe([[0, 2]])
  const before = readFileSync(recipePath, 'utf8')
  expectValidationError(
    run([...editCommand.slice(0, -1), recipePath]),
    'Report must be distinct from the recipe, sources, and outputs',
  )
  expect(readFileSync(recipePath, 'utf8')).toBe(before)
})

test('rejects ambiguous IDs and missing selections', () => {
  writeRecipe([[0, 2]])
  expectValidationError(run([...editCommand, '--only', 'absent']), 'No matching clips in the recipe')
  const recipe = JSON.parse(readFileSync(recipePath, 'utf8'))
  recipe.clips.push(recipe.clips[0])
  writeFileSync(recipePath, JSON.stringify(recipe))
  expectValidationError(run(editCommand), 'Clip IDs must be unique')
})

test('records the actual default poster time for a subsecond edit', () => {
  writeFileSync(
    recipePath,
    JSON.stringify({
      version: 1,
      clips: [{ id: 'short', source: 'source.mp4', keep: [[0, 0.25]], output: 'short.mp4', poster: 'short.webp' }],
    }),
  )
  const result = run(editCommand)
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  const [report] = JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8'))
  expect(report.posterAt).toBe(0)
  expect(report.duration).toBeLessThan(0.4)
})

/** Capture a disposable command, preserving the real exit and raw evidence. */
const captureCommand = (name: string, code: string, options: string[] = []) => {
  const path = join(directory, `${name}.cast.json`)
  const result = run([
    python,
    recorder,
    'record',
    '--cwd',
    directory,
    '--output',
    path,
    ...options,
    '--',
    python,
    '-c',
    code,
  ])
  return { result, path }
}

test('PTY timeout stops the command and marks the recording', () => {
  const { result, path } = captureCommand('timeout', 'import time; print("started",flush=True); time.sleep(30)', [
    '--timeout',
    '.2',
  ])
  expect(result.exitCode, result.stderr.toString()).toBe(124)
  const recording = JSON.parse(readFileSync(path, 'utf8'))
  expect(recording.timedOut).toBe(true)
  expect(recording.exit).toBeLessThan(0)
})

test('PTY capture waits for the real exit after the command closes its output', () => {
  const { result, path } = captureCommand(
    'closed-output',
    'import os,time; os.close(0); os.close(1); os.close(2); time.sleep(.1); os._exit(7)',
  )
  expect(result.exitCode, result.stderr.toString()).toBe(7)
  expect(JSON.parse(readFileSync(path, 'utf8')).exit).toBe(7)
})

test('PTY signal exits use shell-compatible status while preserving the original signal', () => {
  const { result, path } = captureCommand('signal', 'import os,signal; os.kill(os.getpid(),signal.SIGTERM)')
  expect(result.exitCode, result.stderr.toString()).toBe(143)
  expect(JSON.parse(readFileSync(path, 'utf8')).exit).toBe(-15)
})

test('PTY capture preserves split UTF-8 and an incomplete final sequence', () => {
  const { result, path } = captureCommand(
    'unicode',
    'import os,time; os.write(1,b"\\xe2"); time.sleep(.02); os.write(1,b"\\x9a\\xa1\\xe2")',
  )
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  const recording = JSON.parse(readFileSync(path, 'utf8'))
  expect(
    recording.events
      .slice(1)
      .map((event: [number, string]) => event[1])
      .join(''),
  ).toBe('⚡�')
})

test.each([
  ['--timeout', 'nan', 'Timeout must be finite and positive'],
  ['--timeout', '0', 'Timeout must be finite and positive'],
  ['--rows', '0', 'Terminal rows and columns must be from 1 to 65535'],
  ['--columns', '65536', 'Terminal rows and columns must be from 1 to 65535'],
])('invalid capture option %s=%s fails before running a command', (option, value, error) => {
  const { result } = captureCommand(`invalid-${option}-${value}`, 'raise Exception("must not execute")', [
    option,
    value,
  ])
  expectValidationError(result, error)
})

test('PTY timeout kills descendants that ignore termination after their leader exits', async () => {
  const marker = join(directory, 'surviving-descendant')
  const child = `import signal,time,pathlib; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(.7); pathlib.Path(${JSON.stringify(marker)}).write_text("survived")`
  const command = `import subprocess,sys,time; subprocess.Popen([sys.executable,"-c",${JSON.stringify(child)}]); time.sleep(30)`
  const { result } = captureCommand('descendants', command, ['--timeout', '.25'])
  expect(result.exitCode, result.stderr.toString()).toBe(124)
  await Bun.sleep(800)
  expect(existsSync(marker)).toBe(false)
})

test('PTY capture refuses to replace raw evidence or execute the command', () => {
  const path = join(directory, 'immutable.cast.json')
  writeFileSync(path, 'raw evidence')
  const { result } = captureCommand('immutable', 'raise Exception("must not execute")')
  expectValidationError(result, 'Choose a new capture path; raw recordings are immutable')
  expect(readFileSync(path, 'utf8')).toBe('raw evidence')
})
