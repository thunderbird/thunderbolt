/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type EditToolInput,
  type ReadToolInput,
  type WriteToolInput,
} from '@earendil-works/pi-coding-agent'

/** Format consistent rejection for model-supplied workspace escapes. */
const pathEscapeMessage = (path: string): string => `path escapes workspace: ${path}`

/** True when candidate is workspace root or inside its subtree. */
export const isWithinWorkspace = (workspaceDir: string, candidate: string): boolean => {
  const relativePath = relative(workspaceDir, candidate)
  return (
    relativePath === '' ||
    (!isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${sep}`))
  )
}

/** Reject candidate unless it is workspace root or descendant. */
const assertWithinWorkspace = (workspaceDir: string, candidate: string, inputPath: string): void => {
  if (!isWithinWorkspace(workspaceDir, candidate)) throw new Error(pathEscapeMessage(inputPath))
}

/** True for filesystem errors caused by a missing path component. */
const isMissingPathError = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')

/** Resolve closest existing ancestor through symlinks. */
const realExistingAncestor = async (path: string): Promise<string> => {
  try {
    return await realpath(path)
  } catch (error) {
    if (!isMissingPathError(error) || dirname(path) === path) throw error
    return realExistingAncestor(dirname(path))
  }
}

/**
 * Resolve existing path against workspace and reject lexical or symlink escape.
 *
 * @param workspaceDir - trusted workspace root
 * @param inputPath - model-supplied relative or absolute path
 */
export const resolveExistingPathInWorkspace = async (workspaceDir: string, inputPath: string): Promise<string> => {
  const realWorkspace = await realpath(workspaceDir)
  const candidate = resolve(realWorkspace, inputPath)
  assertWithinWorkspace(realWorkspace, candidate, inputPath)
  const realCandidate = await realpath(candidate)
  assertWithinWorkspace(realWorkspace, realCandidate, inputPath)
  return realCandidate
}

/**
 * Resolve writable path and verify its closest existing ancestor remains inside workspace.
 *
 * @param workspaceDir - trusted workspace root
 * @param inputPath - model-supplied relative or absolute path
 */
export const resolveWritablePathInWorkspace = async (workspaceDir: string, inputPath: string): Promise<string> => {
  const realWorkspace = await realpath(workspaceDir)
  const candidate = resolve(realWorkspace, inputPath)
  assertWithinWorkspace(realWorkspace, candidate, inputPath)
  try {
    const realCandidate = await realpath(candidate)
    assertWithinWorkspace(realWorkspace, realCandidate, inputPath)
    return realCandidate
  } catch (error) {
    if (!isMissingPathError(error)) throw error
    assertWithinWorkspace(realWorkspace, await realExistingAncestor(candidate), inputPath)
    return candidate
  }
}

/** True when existing model-supplied path can be proven inside workspace. */
export const isExistingPathInWorkspace = async (workspaceDir: string, inputPath: string): Promise<boolean> => {
  try {
    await resolveExistingPathInWorkspace(workspaceDir, inputPath)
    return true
  } catch {
    return false
  }
}

/** Build coding tools with read, write, and edit paths confined to workspace. */
export const createWorkspaceTools = (workspaceDir: string): AgentTool[] => {
  const read = createReadTool(workspaceDir)
  const write = createWriteTool(workspaceDir)
  const edit = createEditTool(workspaceDir)

  const jailedRead: AgentTool = {
    ...read,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const input = params as ReadToolInput
      const path = await resolveExistingPathInWorkspace(workspaceDir, input.path)
      return read.execute(toolCallId, { ...input, path }, signal, onUpdate)
    },
  }
  const jailedWrite: AgentTool = {
    ...write,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const input = params as WriteToolInput
      const path = await resolveWritablePathInWorkspace(workspaceDir, input.path)
      return write.execute(toolCallId, { ...input, path }, signal, onUpdate)
    },
  }
  const jailedEdit: AgentTool = {
    ...edit,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const input = params as EditToolInput
      const path = await resolveExistingPathInWorkspace(workspaceDir, input.path)
      return edit.execute(toolCallId, { ...input, path }, signal, onUpdate)
    },
  }

  return [createBashTool(workspaceDir), jailedRead, jailedWrite, jailedEdit]
}
