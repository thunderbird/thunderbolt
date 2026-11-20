/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'

import { downloadFile, type DownloadNative } from '@/lib/download'
import { getClock } from '@/testing-library'
import { SavedFileNotice } from './saved-file-notice'

/** A phone whose native save keeps the name it is given. */
const phone = (platform: 'ios' | 'android'): DownloadNative => ({
  platform,
  fs: { writeTextFile: async () => {}, writeFile: async () => {} },
  invoke: async (_command, args) => ({ name: args.name }),
})

const save = () => downloadFile({ name: 'q3.html', contents: 'x', mimeType: 'text/html' }, phone('android'))

describe('SavedFileNotice', () => {
  afterEach(cleanup)

  it.each([
    ['android', 'Saved q3.html to Downloads.'],
    ['ios', 'Saved q3.html to the Files app.'],
  ] as const)('says where a save on %s went', async (platform, message) => {
    render(<SavedFileNotice />)
    expect(screen.getByRole('status')).toHaveTextContent('')

    await act(async () => {
      await downloadFile({ name: 'q3.html', contents: 'x', mimeType: 'text/html' }, phone(platform))
    })

    expect(screen.getByRole('status')).toHaveTextContent(message)
  })

  it('goes away after four seconds', async () => {
    render(<SavedFileNotice />)
    await act(async () => {
      await save()
    })

    await act(async () => {
      await getClock().tickAsync(4_000)
    })

    expect(screen.getByRole('status')).toHaveTextContent('')
  })
})
