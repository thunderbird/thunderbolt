/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Plugin } from 'vite'

const providers = [
  { packageName: 'tinfoil', adapter: '/src/attestation/tinfoil.ts' },
  { packageName: 'privatemode-ai', adapter: '/src/attestation/privatemode.ts' },
] as const

type Provider = (typeof providers)[number]['packageName']
type Module = { id: string; isEntry: boolean; imports: readonly string[] }
type Chunk = {
  fileName: string
  facadeModuleId: string | null
  isEntry: boolean
  imports: readonly string[]
  dynamicImports: readonly string[]
  moduleIds: readonly string[]
}

/** Compare resolved module paths across operating systems and Vite query suffixes. */
const modulePath = (id: string): string => id.replaceAll('\\', '/').split('?')[0]

/** Identify the only application modules allowed to load confidential SDKs. */
const adapterProvider = (id: string | null): Provider | undefined =>
  id ? providers.find(({ adapter }) => modulePath(id).endsWith(adapter))?.packageName : undefined

/** Match installed, nested, and externalized SDK imports, including SDK subpaths. */
const sdkProvider = (id: string): Provider | undefined =>
  providers.find(
    ({ packageName }) =>
      id === packageName ||
      id.startsWith(`${packageName}/`) ||
      modulePath(id).includes(`/node_modules/${packageName}/`),
  )?.packageName

/** Follow the resolved source graph, optionally stopping at the SDK adapters. */
const reachableModules = (roots: readonly string[], modules: Map<string, Module>, stopAtAdapters = false) => {
  const reached = new Set<string>()
  const visit = (id: string) => {
    if (reached.has(id) || (stopAtAdapters && adapterProvider(id))) {
      return
    }
    reached.add(id)
    modules.get(id)?.imports.forEach(visit)
  }
  roots.forEach(visit)
  return reached
}

/**
 * Verify emitted chunks, including every lazy route that desktop startup may warm.
 * Shared dependencies independently used by the application are intentionally not
 * classified as SDK code; SDK-exclusive transitive dependencies are protected too.
 */
export const confidentialSdkIsolationErrors = (
  chunks: readonly Chunk[],
  sourceModules: readonly Module[],
): string[] => {
  const modules = new Map(sourceModules.map((module) => [module.id, module]))
  const independent = reachableModules(
    sourceModules.filter((module) => module.isEntry).map((module) => module.id),
    modules,
    true,
  )
  const protectedModules = new Map<string, Set<Provider>>()
  for (const { packageName } of providers) {
    const roots = sourceModules.filter(({ id }) => sdkProvider(id) === packageName).map(({ id }) => id)
    for (const id of reachableModules(roots, modules)) {
      if (independent.has(id) && !sdkProvider(id)) {
        continue
      }
      const owners = protectedModules.get(id) ?? new Set<Provider>()
      owners.add(packageName)
      protectedModules.set(id, owners)
    }
  }

  const byFileName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]))
  const errors = new Set<string>()

  /** Inspect actual output imports; source-level lazy imports alone do not prevent vendor-chunk hoisting. */
  const inspect = (roots: readonly Chunk[], provider?: Provider) => {
    const reached = new Set<string>()
    const visit = (fileName: string, route: readonly string[]) => {
      if (reached.has(fileName)) {
        return
      }
      reached.add(fileName)
      const chunk = byFileName.get(fileName)
      const ids = chunk?.moduleIds ?? [fileName]
      for (const id of ids) {
        const directProvider = sdkProvider(id)
        const owners = directProvider ? new Set([directProvider]) : protectedModules.get(id)
        if (!owners || (provider && owners.has(provider))) {
          continue
        }
        errors.add(
          `${provider ?? 'Application'} loads ${[...owners].join('/')} SDK code outside its dynamic adapter: ${[...route, fileName].join(' -> ')} (${id})`,
        )
      }
      if (!chunk) {
        return
      }
      const nextRoute = [...route, fileName]
      chunk.imports.forEach((dependency) => visit(dependency, nextRoute))
      for (const dependency of chunk.dynamicImports) {
        // These are explicit provider-use boundaries. Everything else, including
        // lazy settings pages and shared vendor chunks, must be safe to import.
        if (adapterProvider(byFileName.get(dependency)?.facadeModuleId ?? null)) {
          continue
        }
        visit(dependency, nextRoute)
      }
    }
    roots.forEach(({ fileName }) => visit(fileName, []))
  }

  inspect(chunks.filter((chunk) => chunk.isEntry))
  for (const { packageName } of providers) {
    inspect(
      chunks.filter((chunk) => adapterProvider(chunk.facadeModuleId) === packageName),
      packageName,
    )
  }
  return [...errors]
}

/** Fail the production build if chunking makes an unused confidential SDK executable. */
export const confidentialSdkIsolationPlugin = (): Plugin => ({
  name: 'confidential-sdk-isolation',
  apply: 'build',
  enforce: 'post',
  generateBundle(_options, bundle) {
    const modules = [...this.getModuleIds()].flatMap((id): Module[] => {
      const info = this.getModuleInfo(id)
      return info ? [{ id, isEntry: info.isEntry, imports: [...info.importedIds, ...info.dynamicallyImportedIds] }] : []
    })
    const chunks = Object.values(bundle).filter((output) => output.type === 'chunk')
    const errors = confidentialSdkIsolationErrors(chunks, modules)
    if (errors.length) {
      this.error(errors.join('\n'))
    }
  },
})
