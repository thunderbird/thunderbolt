/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { InputOTP, InputOTPSlots } from '@/components/ui/input-otp'
import { otpLength } from '@/lib/constants'

const slots = (container: HTMLElement) => container.querySelectorAll('[data-slot="input-otp-slot"]')

const renderSlots = (maxLength: number, length?: number) =>
  render(
    <InputOTP maxLength={maxLength} value="">
      <InputOTPSlots length={length} />
    </InputOTP>,
  )

describe('InputOTPSlots', () => {
  afterEach(cleanup)

  it('defaults to the sign-in code length', () => {
    const { container } = renderSlots(otpLength)
    expect(slots(container)).toHaveLength(otpLength)
  })

  // The reason the prop exists: a consumer whose field length differs from
  // `otpLength` would otherwise render a row of boxes that disagrees with what
  // the input accepts.
  it('renders exactly the requested number of slots', () => {
    const { container } = renderSlots(4, 4)
    expect(slots(container)).toHaveLength(4)
  })
})
