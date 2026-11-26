/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { existsSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import path from 'node:path'

type PackageJson = {
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

const readPackageJson = (dir: string): PackageJson => JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))

/**
 * Node-style lookup: the nearest `node_modules/<name>` walking up from `fromDir`, stopping at `rootDir` or, for a
 * package whose real path lies outside it, at the filesystem root.
 */
const resolvePackage = (rootDir: string, fromDir: string, name: string): string | null => {
  const candidate = path.join(fromDir, 'node_modules', name)
  if (existsSync(path.join(candidate, 'package.json'))) {
    return realpathSync(candidate)
  }
  if (fromDir === rootDir || path.dirname(fromDir) === fromDir) {
    return null
  }
  return resolvePackage(rootDir, path.dirname(fromDir), name)
}

/** Edges a production install must satisfy: regular, optional and required-peer dependencies, never optional peers. */
const runtimeEdges = (pkg: PackageJson) => {
  const optionalPeers = Object.entries(pkg.peerDependenciesMeta ?? {})
    .filter(([, meta]) => meta.optional)
    .map(([name]) => name)
  const requiredPeers = Object.keys(pkg.peerDependencies ?? {}).filter((name) => !optionalPeers.includes(name))
  return [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {}), ...requiredPeers]
}

/** Package names under `nodeModules`, expanding `@scope/*` and skipping dot entries such as `.bin`. */
const listTopLevelPackages = (nodeModules: string) =>
  readdirSync(nodeModules)
    .filter((entry) => !entry.startsWith('.'))
    .flatMap((entry) =>
      entry.startsWith('@')
        ? readdirSync(path.join(nodeModules, entry)).map((scoped) => `${entry}/${scoped}`)
        : [entry],
    )

/**
 * Top-level packages in `rootDir/node_modules` that no production dependency reaches. `bun install --production`
 * still installs a devDependency that a runtime package lists as an optional peer, which put `next` and
 * `drizzle-kit`, with their critical CVEs, in the backend image. Bun fixed only the case where the project itself
 * declares the optional peer (oven-sh/bun#18027); delete this script once a dependency's optional peer is covered too.
 */
export const findUnreachablePackages = (rootDir: string) => {
  // Every path the walk compares is a real path, so the root must be one too.
  const root = realpathSync(rootDir)
  const reached = new Set<string>()
  const visit = (dir: string) => {
    if (reached.has(dir)) {
      return
    }
    reached.add(dir)
    for (const name of runtimeEdges(readPackageJson(dir))) {
      const resolved = resolvePackage(root, dir, name)
      if (resolved) {
        visit(resolved)
      }
    }
  }
  visit(root)

  const nodeModules = path.join(root, 'node_modules')
  return listTopLevelPackages(nodeModules).filter((name) => !reached.has(realpathSync(path.join(nodeModules, name))))
}

/** Deletes the unreachable packages and returns their names. */
export const pruneUnreachablePackages = (rootDir: string) => {
  const unreachable = findUnreachablePackages(rootDir)
  for (const name of unreachable) {
    rmSync(path.join(rootDir, 'node_modules', name), { recursive: true, force: true })
  }
  return unreachable
}

if (import.meta.main) {
  const pruned = pruneUnreachablePackages(path.resolve(process.argv[2] ?? '.'))
  console.log(`Pruned ${pruned.length} packages no production dependency reaches: ${pruned.join(', ')}`)
}
