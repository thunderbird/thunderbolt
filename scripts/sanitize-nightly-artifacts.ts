/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { existsSync } from 'node:fs'
import { readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import JSZip from 'jszip'

const traceFields = new Set([
  'version',
  'type',
  'origin',
  'browserName',
  'playwrightVersion',
  'platform',
  'wallTime',
  'monotonicTime',
  'sdkLanguage',
  'contextId',
  'pageId',
  'callId',
  'stepId',
  'parentId',
  'startTime',
  'endTime',
  'time',
  'class',
  'method',
])
const reportFields = new Set([
  'startTime',
  'duration',
  'files',
  'projectNames',
  'stats',
  'fileId',
  'fileName',
  'tests',
  'testId',
  'title',
  'projectName',
  'location',
  'outcome',
  'path',
  'ok',
  'results',
  'retry',
  'status',
  'workerIndex',
  'name',
  'contentType',
  'file',
  'line',
  'column',
  'total',
  'expected',
  'unexpected',
  'flaky',
  'skipped',
])
const embeddedReport =
  /<template id="playwrightReportBase64">data:application\/zip;base64,([A-Za-z0-9+/=]+)<\/template>/g
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** Retain trace action identifiers and timing, discarding params and snapshots. */
const sanitizeTrace = (content: string): string =>
  content
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const event = JSON.parse(line) as Record<string, JsonValue>
      return JSON.stringify(Object.fromEntries(Object.entries(event).filter(([key]) => traceFields.has(key))))
    })
    .join('\n') + '\n'

/** Rebuild a trace ZIP from approved entries so resources cannot survive compression. */
const sanitizeZip = async (path: string): Promise<void> => {
  const source = await JSZip.loadAsync(await readFile(path), { checkCRC32: true })
  const entries = Object.values(source.files).filter((entry) => !entry.dir)
  if (!entries.some((entry) => entry.name.endsWith('.trace'))) throw new Error('Trace ZIP has no trace')
  const target = new JSZip()
  for (const entry of entries) {
    const { name } = entry
    if (name.endsWith('.trace')) target.file(name, sanitizeTrace(await entry.async('string')))
    if (name.endsWith('.network')) target.file(name, '')
    if (name.endsWith('.stacks')) target.file(name, '{"files":[],"stacks":[]}')
  }
  await writeFile(path, await target.generateAsync({ type: 'nodebuffer' }))
}

/** Keep only report fields needed to identify failed tests and their timing. */
const sanitizeReport = (content: string): string => {
  const report = JSON.parse(content) as JsonValue
  if (report === null || Array.isArray(report) || Object.getPrototypeOf(report) !== Object.prototype) {
    throw new Error('Invalid Playwright report entry')
  }
  return JSON.stringify(report, function (this: JsonValue, key: string, value: JsonValue) {
    if (value === report || Array.isArray(this)) return value
    if (['steps', 'errors', 'annotations', 'tags', 'machines'].includes(key)) return []
    if (['metadata', 'options'].includes(key)) return {}
    if (key === 'attachments') {
      return (value as JsonValue[]).filter((item) => {
        const attachment = item as { name: string; path: string }
        return (
          (attachment.name === 'trace' && attachment.path.endsWith('.zip')) ||
          (attachment.name === 'video' && attachment.path.endsWith('.webm'))
        )
      })
    }
    return reportFields.has(key) ? value : undefined
  })
}

/** Replace Playwright's embedded report ZIP after recursively removing unsafe fields. */
const sanitizeHtml = async (path: string): Promise<void> => {
  const html = await readFile(path, 'utf8')
  const matches = [...html.matchAll(embeddedReport)]
  if (matches.length !== 1) throw new Error('Expected one embedded Playwright report')
  const encoded = matches[0][1]
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.toString('base64') !== encoded) throw new Error('Invalid embedded report encoding')
  const source = await JSZip.loadAsync(bytes, { checkCRC32: true })
  if (!source.file('report.json')) throw new Error('Missing Playwright report summary')
  const target = new JSZip()
  for (const entry of Object.values(source.files)) {
    if (entry.dir) continue
    target.file(entry.name, sanitizeReport(await entry.async('string')))
  }
  const replacement = (await target.generateAsync({ type: 'nodebuffer' })).toString('base64')
  await writeFile(path, html.replace(matches[0][0], matches[0][0].replace(encoded, replacement)))
}

/** Sanitize every uploaded ZIP and remove Playwright data files other than traces and videos. */
const sanitizeDirectory = async (root: string): Promise<void> => {
  if (!existsSync(root)) return
  for (const name of new Bun.Glob('**/*.zip').scanSync({ cwd: root, onlyFiles: true })) {
    await sanitizeZip(join(root, name))
  }
  const data = join(root, 'data')
  if (existsSync(data)) {
    for (const entry of await readdir(data, { withFileTypes: true })) {
      if (!entry.isFile()) throw new Error('Unexpected report data entry')
      if (!entry.name.endsWith('.zip') && !entry.name.endsWith('.webm')) await unlink(join(data, entry.name))
    }
  }
  await sanitizeHtml(join(root, 'index.html'))
}

await sanitizeDirectory(process.argv[2]).catch(() => {
  console.error('Nightly artifact sanitization failed')
  process.exitCode = 1
})
