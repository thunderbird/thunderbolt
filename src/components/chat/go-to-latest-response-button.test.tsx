/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'bun:test'
import { GoToLatestResponseButton } from './go-to-latest-response-button'
import { responseHeadingId } from './latest-response'

afterEach(cleanup)

it('moves focus to the response heading only when activated', () => {
  render(
    <>
      <h2 id={responseHeadingId('older')} tabIndex={-1}>
        Response
      </h2>
      <h2 id={responseHeadingId('latest')} tabIndex={-1}>
        Response
      </h2>
      <textarea aria-label="Message" autoFocus />
      <GoToLatestResponseButton messageId="latest" />
    </>,
  )
  const textarea = screen.getByRole('textbox', { name: 'Message' })
  expect(textarea).toHaveFocus()

  fireEvent.click(screen.getByRole('button', { name: 'Go to latest response' }))
  expect(document.activeElement?.id).toBe(responseHeadingId('latest'))
})
