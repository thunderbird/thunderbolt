/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, mock, test } from 'bun:test'
import { pushRelease, updateReleaseBranch } from './release-git'

describe('release publication', () => {
  test('refreshes the branch and tags before calculating a version', () => {
    const git = mock((args: string[]) => (args[0] === 'symbolic-ref' ? 'main' : ''))
    updateReleaseBranch(git)
    expect(git.mock.calls).toEqual([
      [['symbolic-ref', '--short', 'HEAD']],
      [['fetch', '--tags', 'origin', 'main']],
      [['merge', '--ff-only', 'FETCH_HEAD']],
    ])
  })

  test('publishes branch and tag in one atomic push', () => {
    const git = mock((args: string[]) => (args[0] === 'symbolic-ref' ? 'main' : 'original'))
    pushRelease('v1.2.3', git)
    expect(git.mock.calls.at(-1)).toEqual([['push', '--atomic', 'origin', 'HEAD:refs/heads/main', 'refs/tags/v1.2.3']])
  })

  test('rebases and moves the local tag before retrying a concurrent branch update', () => {
    const git = mock((args: string[]): string => {
      if (args[0] === 'symbolic-ref') return 'main'
      if (args[0] === 'rev-parse') return args[1] === 'FETCH_HEAD' ? 'advanced' : 'original'
      if (args[0] === 'push' && git.mock.calls.filter(([command]) => command[0] === 'push').length === 1) {
        throw new Error('non-fast-forward')
      }
      return ''
    })
    pushRelease('v1.2.3', git)
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
      if (args[0] === 'push') throw failure
      return args[0] === 'symbolic-ref' ? 'main' : 'original'
    })
    expect(() => pushRelease('v1.2.3', git)).toThrow(failure)
    expect(git.mock.calls.filter(([args]) => args[0] === 'push')).toHaveLength(1)
    expect(git.mock.calls.some(([args]) => args[0] === 'tag')).toBe(false)
  })

  test('stops on a rebase conflict without moving or publishing the tag', () => {
    const git = mock((args: string[]): string => {
      if (args[0] === 'symbolic-ref') return 'main'
      if (args[0] === 'rev-parse') return args[1] === 'FETCH_HEAD' ? 'advanced' : 'original'
      if (args[0] === 'push') throw new Error('non-fast-forward')
      if (args[0] === 'rebase') throw new Error('conflict')
      return ''
    })
    expect(() => pushRelease('v1.2.3', git)).toThrow('conflict')
    expect(git.mock.calls.some(([args]) => args[0] === 'tag')).toBe(false)
  })

  test('bounds retries when the branch keeps advancing', () => {
    const git = mock((args: string[]): string => {
      if (args[0] === 'symbolic-ref') return 'main'
      if (args[0] === 'rev-parse') return args[1] === 'FETCH_HEAD' ? 'advanced' : 'original'
      if (args[0] === 'push') throw new Error('non-fast-forward')
      return ''
    })
    expect(() => pushRelease('v1.2.3', git)).toThrow('non-fast-forward')
    expect(git.mock.calls.filter(([args]) => args[0] === 'push')).toHaveLength(3)
  })
})
