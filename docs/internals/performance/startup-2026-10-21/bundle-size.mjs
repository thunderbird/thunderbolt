// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { gzipSync } from 'node:zlib'
import ts from 'typescript'
const buildDirectory = process.argv[3]
const html = readFileSync(resolve(buildDirectory, 'index.html'), 'utf8')
const entry = html.match(/src="([^"]*entry-[^"]*\.js)"/)[1]
const files = new Map()
const visit = (path) => {
  if (files.has(path)) return
  const content = readFileSync(path, 'utf8')
  files.set(path, { raw: Buffer.byteLength(content), gzip: gzipSync(content).byteLength })
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS)
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue
    const spec = statement.moduleSpecifier?.text
    if (spec?.startsWith('.') && spec.endsWith('.js')) {
      const target = resolve(dirname(path), spec)
      if (existsSync(target)) visit(target)
    }
  }
}
visit(resolve(buildDirectory, entry.replace(/^\//, '')))
const result = {
  entry,
  files: Object.fromEntries(files),
  totalRaw: [...files.values()].reduce((sum, x) => sum + x.raw, 0),
  totalGzip: [...files.values()].reduce((sum, x) => sum + x.gzip, 0),
}
writeFileSync(process.argv[2], JSON.stringify(result, null, 2))
console.log(JSON.stringify(result))
