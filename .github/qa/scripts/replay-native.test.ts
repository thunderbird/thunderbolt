/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from 'bun:test'
import { videoPath } from './replay-native'

test('no two replay legs write the same video, though each counts its runs from 1', () => {
  // The judge and the file job merge every leg into one qa-out; each leg runs the control flow first.
  const paths = ['ios', 'android', 'android-sync', 'android-real'].flatMap((leg) =>
    [1, 2, 3].map((run) => videoPath('qa-out', leg, 'control', run)),
  )
  expect(new Set(paths).size).toBe(paths.length)
  expect(videoPath('qa-out', 'android', 'c2-chat-power-user-android', 4)).toBe(
    'qa-out/videos/android-c2-chat-power-user-android-run-4.mp4',
  )
  // A fix's check runs alone in its own folder, with no leg.
  expect(videoPath('out', undefined, 'c1-first-run-ios', 1)).toBe('out/videos/c1-first-run-ios-run-1.mp4')
})
