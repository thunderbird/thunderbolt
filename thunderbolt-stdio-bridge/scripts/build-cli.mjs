// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Bundles bin/cli.js (and its src/ deps) into a single self-contained
// dist/bridge.cjs that install.sh ships verbatim from GitHub Releases. esbuild
// inlines the package version as the __BRIDGE_VERSION__ global referenced by
// the CLI (so --version works in the bundle), prepends a node shebang so the
// bare file is directly executable, and keeps the native ws acceleration addons
// external (they are optional and resolved at runtime if present).

import { build } from 'esbuild'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outfile = join(root, 'dist', 'bridge.cjs')

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

await build({
  entryPoints: [join(root, 'bin', 'cli.js')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  // Native ws speedups: optional deps, loaded lazily by ws if installed. Keep
  // them external so the bundle never hard-requires a compiled addon.
  external: ['bufferutil', 'utf-8-validate'],
  define: { __BRIDGE_VERSION__: JSON.stringify(pkg.version) },
  // No shebang banner: esbuild preserves the entry's own `#!/usr/bin/env node`
  // (bin/cli.js line 1) atop the bundle. Adding a banner shebang too yields a
  // duplicate second `#!` line, which Node rejects as a syntax error.
})

await chmod(outfile, 0o755)

// Windows ignores the shebang and won't run a bare bridge.cjs from PATH, so emit
// a sibling .cmd shim that forwards every arg to node bridge.cjs.
const cmd = '@echo off\r\nnode "%~dp0bridge.cjs" %*\r\n'
await writeFile(join(root, 'dist', 'thunderbolt-stdio-bridge.cmd'), cmd)

console.error(`built ${outfile} (v${pkg.version})`)
