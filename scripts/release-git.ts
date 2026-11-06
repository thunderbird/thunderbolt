/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { execFileSync } from 'node:child_process'

type GitCommand = (args: string[]) => string

/** Run Git without shell interpolation, preserving diagnostics on stderr. */
const runGit: GitCommand = (args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()

/** Start release version calculation from the current remote branch, including tags. */
export const updateReleaseBranch = (git: GitCommand = runGit): void => {
  const branch = git(['symbolic-ref', '--short', 'HEAD'])
  git(['fetch', '--tags', 'origin', branch])
  git(['merge', '--ff-only', 'FETCH_HEAD'])
}

/** Publish the release commit and tag together, rebasing if a concurrent push wins. */
export const pushRelease = (tag: string, git: GitCommand = runGit): void => {
  const branch = git(['symbolic-ref', '--short', 'HEAD'])
  for (const attempt of [1, 2, 3]) {
    const remoteHead = git(['rev-parse', `refs/remotes/origin/${branch}`])
    try {
      git(['push', '--atomic', 'origin', `HEAD:refs/heads/${branch}`, `refs/tags/${tag}`])
      return
    } catch (error) {
      git(['fetch', 'origin', branch])
      if (attempt === 3 || git(['rev-parse', 'FETCH_HEAD']) === remoteHead) throw error
      git(['rebase', 'FETCH_HEAD'])
      // Only the unpublished local tag moves. Neither remote ref is force-pushed.
      git(['tag', '--force', tag])
    }
  }
}
