/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, mock, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pushRelease, updateReleaseBranch } from './release-git'

/** Run a release against an isolated bare origin, including real atomic-push rejection. */
const withReleaseRepository = (check: (fixture: ReturnType<typeof createReleaseRepository>) => void) => {
  const directory = mkdtempSync(join(tmpdir(), 'release-git-'))
  try {
    check(createReleaseRepository(directory))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

/** Seed independent version/source files so a racing source change can rebase cleanly. */
const createReleaseRepository = (directory: string) => {
  const origin = join(directory, 'origin.git')
  const checkout = join(directory, 'checkout')
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Release test',
    GIT_AUTHOR_EMAIL: 'release@example.invalid',
    GIT_COMMITTER_NAME: 'Release test',
    GIT_COMMITTER_EMAIL: 'release@example.invalid',
  }
  const git = (cwd: string, args: string[], input?: string) =>
    execFileSync('git', args, { cwd, env, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  const commit = (cwd: string, version: string, source: string, parent?: string) => {
    const entries = [
      ['version.txt', version],
      ['source.txt', source],
    ].map(([name, value]) => `100644 blob ${git(cwd, ['hash-object', '-w', '--stdin'], value)}\t${name}`)
    const tree = git(cwd, ['mktree'], `${entries.join('\n')}\n`)
    return git(cwd, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'fixture'])
  }
  git(directory, ['init', '--bare', '--initial-branch=main', origin])
  const tested = commit(origin, '1.2.2', 'tested')
  git(origin, ['update-ref', 'refs/heads/main', tested])
  git(directory, ['clone', origin, checkout])
  // actions/checkout detaches HEAD when given the tested SHA.
  git(checkout, ['checkout', '--detach', tested])
  const local = (args: string[]) => git(checkout, args)
  const remote = (args: string[]) => git(origin, args)
  const release = () => {
    const sha = commit(checkout, '1.2.3', 'tested', tested)
    local(['reset', '--hard', sha])
    local(['tag', 'v1.2.3'])
    return sha
  }
  const advance = () => {
    const sha = commit(origin, '1.2.2', 'untested', tested)
    remote(['update-ref', 'refs/heads/main', sha])
    return sha
  }
  return { directory, checkout, local, remote, release, advance, target: { branch: 'main', expectedSha: tested } }
}

describe('release publication', () => {
  test('refreshes the branch and tags before calculating a version', () => {
    const git = mock((args: string[]) => (args[0] === 'symbolic-ref' ? 'main' : ''))
    updateReleaseBranch({}, git)
    expect(git.mock.calls).toEqual([
      [['symbolic-ref', '--short', 'HEAD']],
      [['fetch', '--tags', 'origin', 'main']],
      [['merge', '--ff-only', 'FETCH_HEAD']],
    ])
  })

  test('publishes branch and tag in one atomic push', () => {
    const git = mock((args: string[]) => (args[0] === 'symbolic-ref' ? 'main' : 'original'))
    pushRelease('v1.2.3', {}, git)
    expect(git.mock.calls.at(-1)).toEqual([['push', '--atomic', 'origin', 'HEAD:refs/heads/main', 'refs/tags/v1.2.3']])
  })

  test('rebases and moves the local tag before retrying a concurrent branch update', () => {
    const git = mock((args: string[]): string => {
      if (args[0] === 'symbolic-ref') {
        return 'main'
      }
      if (args[0] === 'rev-parse') {
        return args[1] === 'FETCH_HEAD' ? 'advanced' : 'original'
      }
      if (args[0] === 'push' && git.mock.calls.filter(([command]) => command[0] === 'push').length === 1) {
        throw new Error('non-fast-forward')
      }
      return ''
    })
    pushRelease('v1.2.3', {}, git)
    expect(git.mock.calls.map(([args]) => args[0])).toEqual([
      'symbolic-ref',
      'rev-parse',
      'push',
      'fetch',
      'rev-parse',
      'rebase',
      'tag',
      'rev-parse',
      'push',
    ])
    expect(git.mock.calls).toContainEqual([['tag', '--force', 'v1.2.3']])
  })

  test('surfaces push failures without retrying when the branch did not advance', () => {
    const failure = new Error('permission denied')
    const git = mock((args: string[]): string => {
      if (args[0] === 'push') {
        throw failure
      }
      return args[0] === 'symbolic-ref' ? 'main' : 'original'
    })
    expect(() => pushRelease('v1.2.3', {}, git)).toThrow(failure)
    expect(git.mock.calls.filter(([args]) => args[0] === 'push')).toHaveLength(1)
    expect(git.mock.calls.some(([args]) => args[0] === 'tag')).toBe(false)
  })

  test('stops on a rebase conflict without moving or publishing the tag', () => {
    const git = mock((args: string[]): string => {
      if (args[0] === 'symbolic-ref') {
        return 'main'
      }
      if (args[0] === 'rev-parse') {
        return args[1] === 'FETCH_HEAD' ? 'advanced' : 'original'
      }
      if (args[0] === 'push') {
        throw new Error('non-fast-forward')
      }
      if (args[0] === 'rebase') {
        throw new Error('conflict')
      }
      return ''
    })
    expect(() => pushRelease('v1.2.3', {}, git)).toThrow('conflict')
    expect(git.mock.calls.some(([args]) => args[0] === 'tag')).toBe(false)
  })

  test('bounds retries when the branch keeps advancing', () => {
    const git = mock((args: string[]): string => {
      if (args[0] === 'symbolic-ref') {
        return 'main'
      }
      if (args[0] === 'rev-parse') {
        return args[1] === 'FETCH_HEAD' ? 'advanced' : 'original'
      }
      if (args[0] === 'push') {
        throw new Error('non-fast-forward')
      }
      return ''
    })
    expect(() => pushRelease('v1.2.3', {}, git)).toThrow('non-fast-forward')
    expect(git.mock.calls.filter(([args]) => args[0] === 'push')).toHaveLength(3)
  })
})

describe('nightly tested revision', () => {
  test('publishes only the release commit directly on top of the tested SHA', () => {
    withReleaseRepository(({ local, remote, release, target }) => {
      expect(updateReleaseBranch(target, local)).toBe(true)
      const released = release()
      expect(pushRelease('v1.2.3', target, local)).toBe(true)
      expect(remote(['rev-parse', 'main'])).toBe(released)
      expect(remote(['rev-parse', 'v1.2.3'])).toBe(released)
      expect(remote(['rev-parse', 'v1.2.3^'])).toBe(target.expectedSha)
      expect(remote(['show', 'v1.2.3:source.txt'])).toBe('tested')
    })
  })

  test('skips an obsolete nightly before changing its checkout or creating a tag', () => {
    withReleaseRepository(({ local, remote, advance, target }) => {
      const advanced = advance()
      expect(updateReleaseBranch(target, local)).toBe(false)
      expect(local(['rev-parse', 'HEAD'])).toBe(target.expectedSha)
      expect(remote(['rev-parse', 'main'])).toBe(advanced)
      expect(remote(['tag', '--list'])).toBe('')
    })
  })

  test('the release CLI reports a clean skip before trying to update version files', () => {
    withReleaseRepository(({ directory, checkout, local, remote, advance, target }) => {
      const advanced = advance()
      mkdirSync(join(checkout, 'scripts'))
      for (const file of ['create-release.ts', 'release-git.ts']) {
        copyFileSync(join(import.meta.dir, file), join(checkout, 'scripts', file))
      }
      writeFileSync(join(checkout, '.git/info/exclude'), 'scripts/\n')
      const output = join(directory, 'output')
      const summary = join(directory, 'summary')
      const result = Bun.spawnSync([process.execPath, 'scripts/create-release.ts', '--push'], {
        cwd: checkout,
        env: {
          ...process.env,
          RELEASE_BRANCH: target.branch,
          RELEASE_EXPECTED_SHA: target.expectedSha,
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(result.exitCode).toBe(0)
      expect(readFileSync(output, 'utf8')).toBe('published=false\n')
      expect(readFileSync(summary, 'utf8')).toContain('Nightly release skipped')
      expect(local(['rev-parse', 'HEAD'])).toBe(target.expectedSha)
      expect(remote(['rev-parse', 'main'])).toBe(advanced)
      expect(remote(['tag', '--list'])).toBe('')
    })
  })

  test('rejects a checkout that does not match the tested revision', () => {
    withReleaseRepository(({ local, release, target }) => {
      release()
      expect(() => updateReleaseBranch(target, local)).toThrow('checkout does not match')
    })
  })

  test('skips a concurrent branch advance without rebasing or publishing either ref', () => {
    withReleaseRepository(({ local, remote, release, advance, target }) => {
      expect(updateReleaseBranch(target, local)).toBe(true)
      const released = release()
      const advanced: string[] = []
      const racingGit = (args: string[]) => {
        if (args[0] === 'push') {
          advanced.push(advance())
        }
        return local(args)
      }
      expect(pushRelease('v1.2.3', target, racingGit)).toBe(false)
      expect(advanced).toHaveLength(1)
      expect(remote(['rev-parse', 'main'])).toBe(advanced[0])
      expect(remote(['tag', '--list'])).toBe('')
      expect(local(['rev-parse', 'HEAD'])).toBe(released)
      expect(local(['rev-parse', 'HEAD^'])).toBe(target.expectedSha)
    })
  })

  test('rejects an untested release parent before pushing', () => {
    withReleaseRepository(({ local, remote, release, target }) => {
      release()
      expect(() => pushRelease('v1.2.3', { ...target, expectedSha: 'wrong-revision' }, local)).toThrow(
        'must directly follow the tested revision',
      )
      expect(remote(['rev-parse', 'main'])).toBe(target.expectedSha)
      expect(remote(['tag', '--list'])).toBe('')
    })
  })

  test('surfaces a tag collision instead of reporting a stale nightly', () => {
    withReleaseRepository(({ local, remote, release, target }) => {
      release()
      remote(['update-ref', 'refs/tags/v1.2.3', target.expectedSha])
      expect(() => pushRelease('v1.2.3', target, local)).toThrow()
      expect(remote(['rev-parse', 'main'])).toBe(target.expectedSha)
      expect(remote(['rev-parse', 'v1.2.3'])).toBe(target.expectedSha)
    })
  })

  test('still allows a manual release to rebase over a concurrent source change', () => {
    withReleaseRepository(({ local, remote, release, advance }) => {
      release()
      advance()
      expect(pushRelease('v1.2.3', { branch: 'main' }, local)).toBe(true)
      expect(remote(['rev-parse', 'main'])).toBe(remote(['rev-parse', 'v1.2.3']))
      expect(remote(['show', 'v1.2.3:version.txt'])).toBe('1.2.3')
      expect(remote(['show', 'v1.2.3:source.txt'])).toBe('untested')
    })
  })
})
