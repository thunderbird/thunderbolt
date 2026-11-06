/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  const dependencies = run([python, '-c', 'import PIL, pyte'])
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

test('a publish failure restores the previous assets and provenance report', () => {
  const result = run([
    python,
    '-c',
    `
import importlib.util, sys, tempfile
from pathlib import Path
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('demo', sys.argv[1])
demo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(demo)
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    files = []
    for name in ('video', 'poster', 'report'):
        source, target = root / (name + '-new'), root / name
        source.write_text('new ' + name)
        target.write_text('old ' + name)
        files.append((source, target))
    replace = Path.replace
    def fail_report(source, target):
        if source.name == 'new' and target == root / 'report':
            raise OSError('simulated report publish failure')
        return replace(source, target)
    with patch.object(Path, 'replace', fail_report):
        try:
            demo.publish_files(files)
        except OSError as error:
            assert str(error) == 'simulated report publish failure'
        else:
            raise AssertionError('expected publish failure')
    for name in ('video', 'poster', 'report'):
        assert (root / name).read_text() == 'old ' + name
print('restored assets and report')
`,
    editor,
  ])
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  expect(result.stdout.toString()).toContain('restored assets and report')
})
