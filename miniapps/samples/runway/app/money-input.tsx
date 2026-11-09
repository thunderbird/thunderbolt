'use client'

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

type Props = {
  value: number
  onValueChange: (value: number) => void
  id?: string
  'aria-label'?: string
}

/** A whole-euro field that shows thousand separators (500,000) and stays editable as plain digits. */
export const MoneyInput = ({ value, onValueChange, ...rest }: Props) => (
  <input
    {...rest}
    type="text"
    inputMode="numeric"
    value={value.toLocaleString('en-US')}
    onChange={(event) => {
      const digits = event.target.value.replace(/[^\d]/g, '')
      onValueChange(digits === '' ? 0 : Number(digits))
    }}
  />
)
