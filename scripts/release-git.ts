/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { execFileSync } from 'node:child_process'

type GitCommand = (args: string[]) => string

export type ReleaseTarget = { branch?: string; expectedSha?: string }

/** Run Git without shell interpolation, preserving diagnostics on stderr. */
const runGit: GitCommand = (args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()

/** Refresh manual releases, or skip a nightly whose tested revision is no longer current. */
export const updateReleaseBranch = (target: ReleaseTarget = {}, git: GitCommand = runGit): boolean => {
  const branch = target.branch ?? git(['symbolic-ref', '--short', 'HEAD'])
  git(['fetch', '--tags', 'origin', branch])
  if (target.expectedSha) {
    if (git(['rev-parse', 'FETCH_HEAD']) !== target.expectedSha) {
      return false
    }
    if (git(['rev-parse', 'HEAD']) !== target.expectedSha) {
      throw new Error('Nightly release checkout does not match the tested revision')
    }
    return true
  }
  git(['merge', '--ff-only', 'FETCH_HEAD'])
  return true
}

/** Publish atomically; stale nightlies skip, while manual releases may rebase and retry. */
export const pushRelease = (tag: string, target: ReleaseTarget = {}, git: GitCommand = runGit): boolean => {
  const branch = target.branch ?? git(['symbolic-ref', '--short', 'HEAD'])
  if (target.expectedSha && git(['rev-parse', 'HEAD^']) !== target.expectedSha) {
    throw new Error('Nightly release commit must directly follow the tested revision')
  }
  for (const attempt of [1, 2, 3]) {
    const remoteHead = git(['rev-parse', `refs/remotes/origin/${branch}`])
    try {
      git(['push', '--atomic', 'origin', `HEAD:refs/heads/${branch}`, `refs/tags/${tag}`])
      return true
    } catch (error) {
      git(['fetch', 'origin', branch])
      const currentRemoteHead = git(['rev-parse', 'FETCH_HEAD'])
      if (target.expectedSha && currentRemoteHead !== target.expectedSha) {
        return false
      }
      if (attempt === 3 || currentRemoteHead === remoteHead) {
        throw error
      }
      git(['rebase', 'FETCH_HEAD'])
      // Only the unpublished local tag moves. Neither remote ref is force-pushed.
      git(['tag', '--force', tag])
    }
  }
  throw new Error('Release push exhausted its retries')
}
