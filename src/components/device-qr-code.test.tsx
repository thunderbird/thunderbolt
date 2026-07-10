/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, render, screen } from '@testing-library/react'
import { expect, it } from 'bun:test'
import DeviceQrCode from './device-qr-code'

it('clears the previous QR image while a new value is rendering', async () => {
  const resolvers: Array<(url: string) => void> = []
  const encode = (): Promise<string> => new Promise((resolve) => resolvers.push(resolve))
  const { rerender } = render(<DeviceQrCode value="old-ticket" encode={encode} />)

  await act(async () => resolvers[0]('data:image/png;base64,old'))
  expect(screen.getByRole('img')).toHaveAttribute('src', 'data:image/png;base64,old')

  rerender(<DeviceQrCode value="new-ticket" encode={encode} />)
  expect(screen.getByRole('img')).not.toHaveAttribute('src')

  await act(async () => resolvers[1]('data:image/png;base64,new'))
  expect(screen.getByRole('img')).toHaveAttribute('src', 'data:image/png;base64,new')
})
