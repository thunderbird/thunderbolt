/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { findUnreachablePackages, pruneUnreachablePackages } from './prune-unreachable-deps'

const writePackage = (dir: string, pkg: object) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg))
}

describe('findUnreachablePackages', () => {
  let root: string
  const installed = (name: string, pkg: object = {}) => writePackage(path.join(root, 'node_modules', name), pkg)

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'prune-deps-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('keeps dependencies, their transitive deps and required peers', () => {
    writePackage(root, { dependencies: { auth: '1' }, devDependencies: { linter: '1' } })
    installed('auth', { dependencies: { jose: '1' }, peerDependencies: { react: '*' } })
    installed('jose')
    installed('react')
    installed('linter')

    expect(findUnreachablePackages(root)).toEqual(['linter'])
  })

  it('drops an optional peer that only a devDependency puts on disk, with everything under it', () => {
    writePackage(root, { dependencies: { auth: '1' }, devDependencies: { 'email-ui': '1' } })
    installed('auth', { peerDependencies: { next: '*' }, peerDependenciesMeta: { next: { optional: true } } })
    installed('email-ui', { dependencies: { next: '1' } })
    installed('next', { dependencies: { '@next/env': '1', postcss: '1' } })
    installed('@next/env')
    installed('postcss')

    expect(findUnreachablePackages(root).sort()).toEqual(['@next/env', 'email-ui', 'next', 'postcss'])
  })

  it('keeps a package an optional peer points at when a runtime dependency also needs it', () => {
    writePackage(root, { dependencies: { auth: '1', web: '1' } })
    installed('auth', { peerDependencies: { next: '*' }, peerDependenciesMeta: { next: { optional: true } } })
    installed('web', { dependencies: { next: '1' } })
    installed('next')

    expect(findUnreachablePackages(root)).toEqual([])
  })

  it('resolves a nested copy before the hoisted one', () => {
    writePackage(root, { dependencies: { a: '1' } })
    installed('a', { dependencies: { b: '2' } })
    writePackage(path.join(root, 'node_modules', 'a', 'node_modules', 'b'), {})
    installed('b')

    expect(findUnreachablePackages(root)).toEqual(['b'])
  })

  it('keeps optionalDependencies such as platform binaries', () => {
    writePackage(root, { dependencies: { esbuild: '1' } })
    installed('esbuild', { optionalDependencies: { '@esbuild/linux-x64': '1' } })
    installed('@esbuild/linux-x64')

    expect(findUnreachablePackages(root)).toEqual([])
  })

  it('skips a declared dependency that is not installed, such as another platform binary', () => {
    writePackage(root, { dependencies: { esbuild: '1' } })
    installed('esbuild', { optionalDependencies: { '@esbuild/other-platform': '1' } })

    expect(findUnreachablePackages(root)).toEqual([])
  })

  it('stops at the filesystem root for a linked package outside the root with a missing dependency', () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'prune-linked-'))
    writePackage(outside, { dependencies: { missing: '1' } })
    writePackage(root, { dependencies: { linked: '1' } })
    mkdirSync(path.join(root, 'node_modules'), { recursive: true })
    symlinkSync(outside, path.join(root, 'node_modules', 'linked'))

    expect(findUnreachablePackages(root)).toEqual([])
    rmSync(outside, { recursive: true, force: true })
  })

  it('pruneUnreachablePackages deletes only the unreachable directories', () => {
    writePackage(root, { dependencies: { keep: '1' } })
    installed('keep')
    installed('@scope/drop')

    expect(pruneUnreachablePackages(root)).toEqual(['@scope/drop'])
    expect(existsSync(path.join(root, 'node_modules', 'keep'))).toBe(true)
    expect(existsSync(path.join(root, 'node_modules', '@scope', 'drop'))).toBe(false)
  })
})
