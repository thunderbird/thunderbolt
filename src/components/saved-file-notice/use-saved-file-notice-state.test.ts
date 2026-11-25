/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'

import { downloadFile, type DownloadNative } from '@/lib/download'
import { getClock } from '@/testing-library'
import { useSavedFileNoticeState } from './use-saved-file-notice-state'

/** An Android phone whose native save keeps the name it is given. */
const android: DownloadNative = {
  platform: 'android',
  fs: { writeTextFile: async () => {}, writeFile: async () => {} },
  invoke: async (_command, args) => ({ name: args.name }),
}

const renderSaved = async () => {
  const hook = renderHook(() => useSavedFileNoticeState())
  await act(async () => {
    await downloadFile({ name: 'q3.html', contents: 'x', mimeType: 'text/html' }, android)
  })
  return hook
}

describe('useSavedFileNoticeState', () => {
  afterEach(cleanup)

  it('holds the latest save on a phone', async () => {
    const { result } = await renderSaved()

    expect(result.current.saved).toEqual({ name: 'q3.html', platform: 'android' })
  })

  it('clears the save after four seconds', async () => {
    const { result } = await renderSaved()

    await act(async () => {
      await getClock().tickAsync(3_999)
    })
    expect(result.current.saved).not.toBeNull()

    await act(async () => {
      await getClock().tickAsync(1)
    })
    expect(result.current.saved).toBeNull()
  })

  it('clears the save when dismissed', async () => {
    const { result } = await renderSaved()

    act(() => result.current.dismiss())

    expect(result.current.saved).toBeNull()
  })
})
