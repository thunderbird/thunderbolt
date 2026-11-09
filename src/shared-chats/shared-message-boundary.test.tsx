/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, spyOn } from 'bun:test'
import { SharedMessageBoundary } from './shared-message-boundary'

afterEach(cleanup)

const Broken = (): never => {
  throw new Error('malformed widget data')
}

it('contains a message that fails to render, keeping its siblings', () => {
  const consoleError = spyOn(console, 'error').mockImplementation(() => {})
  render(
    <div>
      <SharedMessageBoundary>
        <Broken />
      </SharedMessageBoundary>
      <SharedMessageBoundary>
        <p>Next message</p>
      </SharedMessageBoundary>
    </div>,
  )

  expect(screen.getByText('This message can’t be shown.')).toBeInTheDocument()
  expect(screen.getByText('Next message')).toBeInTheDocument()
  consoleError.mockRestore()
})
