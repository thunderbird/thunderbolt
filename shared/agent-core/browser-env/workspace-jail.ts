/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The single workspace jail shared by every browser coding tool. Each thread's
 * tools are rooted at its isolated workspace
 * ({@link import('../build-app-harness.ts').workspaceDirFor}); this asserts that a
 * resolved path stays inside that subtree, so a model-supplied absolute path
 * (`/etc/passwd`) or `..` traversal (`../<otherThread>/secret`) can't reach a
 * sibling thread's files on the shared process-global ZenFS mount.
 *
 * Throwing on an escape is the loud, architectural failure the project's rules
 * favour over silently clamping or ignoring the path.
 */

import { resolve } from '@zenfs/core/path'

/** True when `resolvedPath` is the workspace root itself or inside its subtree. */
export const isWithinWorkspace = (workspaceDir: string, resolvedPath: string): boolean =>
  resolvedPath === workspaceDir || resolvedPath.startsWith(`${workspaceDir}/`)

/**
 * Resolve `path` against `workspaceDir` and assert it stays inside the workspace
 * subtree, throwing `path escapes workspace` otherwise.
 *
 * @param workspaceDir - the thread's absolute workspace root (the jail boundary)
 * @param path - a model-supplied relative or absolute path
 * @returns the resolved absolute path, guaranteed within `workspaceDir`
 */
export const resolveInWorkspace = (workspaceDir: string, path: string): string => {
  const resolved = resolve(workspaceDir, path)
  if (!isWithinWorkspace(workspaceDir, resolved)) {
    throw new Error(`path escapes workspace: ${path}`)
  }
  return resolved
}
