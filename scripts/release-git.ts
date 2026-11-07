/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

type GitCommand = (args: string[]) => string

export type ReleaseTarget = { branch?: string; expectedSha?: string }

/** Run Git without shell interpolation, preserving diagnostics on stderr. */
const runGit: GitCommand = (args) =>
  execFileSync('git', args, {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim()

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

/** Publish atomically; manual retries must regenerate metadata from the new source revision. */
export const pushRelease = (
  initialTag: string,
  target: ReleaseTarget = {},
  git: GitCommand = runGit,
  rebuild?: () => string,
): boolean => {
  const branch = target.branch ?? git(['symbolic-ref', '--short', 'HEAD'])
  if (target.expectedSha && git(['rev-parse', 'HEAD^']) !== target.expectedSha) {
    throw new Error('Nightly release commit must directly follow the tested revision')
  }
  let tag = initialTag
  for (const attempt of [1, 2, 3]) {
    const remoteHead = git(['rev-parse', `refs/remotes/origin/${branch}`])
    const releaseHead = git(['rev-parse', 'HEAD'])
    if (git(['rev-parse', `refs/tags/${tag}`]) !== releaseHead) {
      throw new Error('Release tag does not match the prepared release commit')
    }
    try {
      git(['push', '--atomic', 'origin', `${releaseHead}:refs/heads/${branch}`, `${releaseHead}:refs/tags/${tag}`])
      return true
    } catch (error) {
      git(['fetch', '--tags', 'origin', branch])
      const currentRemoteHead = git(['rev-parse', 'FETCH_HEAD'])
      if (target.expectedSha && currentRemoteHead !== target.expectedSha) {
        return false
      }
      if (attempt === 3 || currentRemoteHead === remoteHead) {
        throw error
      }
      if (!rebuild) {
        throw new Error('Release branch advanced; regenerate version and changelog before publishing', { cause: error })
      }
      if (
        git(['status', '--porcelain']) ||
        git(['rev-parse', 'HEAD']) !== releaseHead ||
        git(['rev-parse', `refs/tags/${tag}`]) !== releaseHead
      ) {
        throw new Error('Release checkout changed; refusing to replace the prepared release', { cause: error })
      }
      // An atomic push can fail for a tag collision, or lose its acknowledgement.
      // In either case an existing remote tag must never be removed or replaced.
      if (git(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`])) {
        throw error
      }
      const sourceHead = git(['rev-parse', 'HEAD^'])
      git(['merge-base', '--is-ancestor', sourceHead, currentRemoteHead])
      git(['reset', '--keep', currentRemoteHead])
      git(['update-ref', '-d', `refs/tags/${tag}`, releaseHead])
      if (git(['status', '--porcelain'])) {
        throw new Error('Release checkout changed before rebuilding', { cause: error })
      }
      tag = rebuild()
    }
  }
  throw new Error('Release push exhausted its retries')
}
