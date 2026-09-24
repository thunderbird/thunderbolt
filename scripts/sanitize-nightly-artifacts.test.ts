/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'

const script = join(import.meta.dir, 'sanitize-nightly-artifacts.ts')
const secret = 'session-secret-marker'

/** Run the same CLI command used by the Nightly workflow. */
const runSanitizer = (root: string) =>
  Bun.spawnSync([process.execPath, script, root], { stdout: 'pipe', stderr: 'pipe' })

test('keeps trace timing, report outcomes, and videos while removing captured content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nightly-sanitize-'))
  try {
    const data = join(root, 'data')
    await mkdir(data)
    const trace = new JSZip()
    trace.file(
      '0-trace.trace',
      `${JSON.stringify({ type: 'before', method: 'fill', startTime: 12, params: { value: secret } })}\n`,
    )
    trace.file('0-trace.network', secret)
    trace.file('0-trace.stacks', secret)
    trace.file('resources/body.txt', secret)
    await writeFile(join(data, 'trace.zip'), await trace.generateAsync({ type: 'nodebuffer' }))
    await writeFile(join(data, 'video.webm'), Buffer.from('synthetic-webm'))
    await writeFile(join(data, 'error.md'), secret)

    const report = new JSZip()
    report.file(
      'report.json',
      JSON.stringify({ stats: { unexpected: 1 }, duration: 42, errors: [secret], metadata: { token: secret } }),
    )
    report.file(
      'file.json',
      JSON.stringify({
        tests: [
          {
            title: 'public test',
            results: [
              {
                status: 'failed',
                duration: 30,
                errors: [secret],
                attachments: [
                  { name: 'trace', path: 'data/trace.zip', body: secret },
                  { name: 'video', path: 'data/video.webm' },
                  { name: 'error-context', path: 'data/error.md', body: secret },
                ],
              },
            ],
          },
        ],
      }),
    )
    const embedded = (await report.generateAsync({ type: 'nodebuffer' })).toString('base64')
    await writeFile(
      join(root, 'index.html'),
      `<html><template id="playwrightReportBase64">data:application/zip;base64,${embedded}</template></html>`,
    )

    expect(runSanitizer(root).exitCode).toBe(0)
    expect(await Bun.file(join(data, 'error.md')).exists()).toBe(false)
    expect(await readFile(join(data, 'video.webm'), 'utf8')).toBe('synthetic-webm')

    const cleanTrace = await JSZip.loadAsync(await readFile(join(data, 'trace.zip')))
    expect(Object.keys(cleanTrace.files).sort()).toEqual(['0-trace.network', '0-trace.stacks', '0-trace.trace'])
    expect(JSON.parse(await cleanTrace.file('0-trace.trace')!.async('string'))).toEqual({
      type: 'before',
      method: 'fill',
      startTime: 12,
    })
    expect(await cleanTrace.file('0-trace.network')!.async('string')).toBe('')
    expect(await cleanTrace.file('0-trace.stacks')!.async('string')).toBe('{"files":[],"stacks":[]}')

    const html = await readFile(join(root, 'index.html'), 'utf8')
    const cleanEmbedded = html.match(/data:application\/zip;base64,([A-Za-z0-9+/=]+)/)?.[1]
    expect(cleanEmbedded).toBeDefined()
    const cleanReport = await JSZip.loadAsync(Buffer.from(cleanEmbedded!, 'base64'))
    const summary = JSON.parse(await cleanReport.file('report.json')!.async('string'))
    const file = JSON.parse(await cleanReport.file('file.json')!.async('string'))
    expect(summary).toEqual({ stats: { unexpected: 1 }, duration: 42, errors: [], metadata: {} })
    expect(file.tests[0].title).toBe('public test')
    expect(file.tests[0].results[0]).toEqual({
      status: 'failed',
      duration: 30,
      errors: [],
      attachments: [
        { name: 'trace', path: 'data/trace.zip' },
        { name: 'video', path: 'data/video.webm' },
      ],
    })
    expect(html).not.toContain(secret)
    expect(await cleanTrace.file('0-trace.trace')!.async('string')).not.toContain(secret)
    expect(await cleanReport.file('file.json')!.async('string')).not.toContain(secret)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects missing or corrupt embedded reports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nightly-sanitize-'))
  try {
    await writeFile(join(root, 'index.html'), '<html>no report</html>')
    expect(runSanitizer(root).exitCode).not.toBe(0)
    await writeFile(
      join(root, 'index.html'),
      '<html><template id="playwrightReportBase64">data:application/zip;base64,bm90LWEtWklQ</template></html>',
    )
    expect(runSanitizer(root).exitCode).not.toBe(0)

    const report = new JSZip()
    report.file('report.json', `invalid-json-${secret}`)
    const embedded = (await report.generateAsync({ type: 'nodebuffer' })).toString('base64')
    await writeFile(
      join(root, 'index.html'),
      `<html><template id="playwrightReportBase64">data:application/zip;base64,${embedded}</template></html>`,
    )
    const result = runSanitizer(root)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toBe('Nightly artifact sanitization failed\n')

    await mkdir(join(root, 'data'))
    await writeFile(join(root, 'data', 'trace.zip'), `invalid-zip-${secret}`)
    expect(runSanitizer(root).stderr.toString()).toBe('Nightly artifact sanitization failed\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects non-file entries in report data before upload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nightly-sanitize-'))
  try {
    await mkdir(join(root, 'data', 'untrusted.webm'), { recursive: true })
    await writeFile(join(root, 'data', 'untrusted.webm', 'secret.txt'), secret)
    const report = new JSZip()
    report.file('report.json', JSON.stringify({ stats: { unexpected: 1 } }))
    const embedded = (await report.generateAsync({ type: 'nodebuffer' })).toString('base64')
    await writeFile(
      join(root, 'index.html'),
      `<html><template id="playwrightReportBase64">data:application/zip;base64,${embedded}</template></html>`,
    )

    expect(runSanitizer(root).exitCode).not.toBe(0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
