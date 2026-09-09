/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'bun:test'
import { Plural, Trans, plural, t, useLingui } from './identity-macros'

describe('lingui identity macros (bun test harness)', () => {
  it('Trans renders its children untouched', () => {
    render(
      <Trans>
        Hello <strong>world</strong>
      </Trans>,
    )
    expect(screen.getByText('world')).toBeInTheDocument()
  })

  it('Plural selects the singular form and substitutes #', () => {
    render(<Plural value={1} one="# chat" other="# chats" />)
    expect(screen.getByText('1 chat')).toBeInTheDocument()
  })

  it('Plural selects the plural form for zero and many', () => {
    render(<Plural value={5} one="# chat" other="# chats" />)
    expect(screen.getByText('5 chats')).toBeInTheDocument()
  })

  it('Plural honours exact _N overrides', () => {
    render(<Plural value={0} _0="No chats" one="# chat" other="# chats" />)
    expect(screen.getByText('No chats')).toBeInTheDocument()
  })

  it('plural() returns the interpolated English form', () => {
    expect(plural(1, { one: '# chat', other: '# chats' })).toBe('1 chat')
    expect(plural(3, { one: '# chat', other: '# chats' })).toBe('3 chats')
  })

  it('t tagged template interpolates values', () => {
    const name = 'Ada'
    expect(t`Hello ${name}!`).toBe('Hello Ada!')
  })

  it('t composes with plural() like the real macro nesting', () => {
    const count = 2
    expect(t`${plural(count, { one: '# chat', other: '# chats' })}`).toBe('2 chats')
  })

  it('useLingui returns the identity t', () => {
    const { t: hookT } = useLingui()
    expect(hookT`Plain text`).toBe('Plain text')
  })
})
