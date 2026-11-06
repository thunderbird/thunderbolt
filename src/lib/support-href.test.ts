/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { supportHref } from './support-href'

const prefill = { subject: 'App%20Error', body: 'Code%3A%201' }

describe('supportHref', () => {
  it('opens a support page as-is', () => {
    expect(supportHref('https://acme.test/help', prefill)).toBe('https://acme.test/help')
  })

  it('prefills a mailto address', () => {
    expect(supportHref('mailto:help@acme.test', prefill)).toBe(
      'mailto:help@acme.test?subject=App%20Error&body=Code%3A%201',
    )
  })

  it('appends to an address that already has a query, keeping a subject the operator set', () => {
    expect(supportHref('mailto:help@acme.test?Subject=Help', prefill)).toBe(
      'mailto:help@acme.test?Subject=Help&body=Code%3A%201',
    )
  })

  it('leaves an address that sets every field alone, and treats MAILTO: as mailto', () => {
    expect(supportHref('mailto:help@acme.test?subject=a&body=b', prefill)).toBe(
      'mailto:help@acme.test?subject=a&body=b',
    )
    expect(supportHref('MAILTO:help@acme.test', prefill)).toBe(
      'MAILTO:help@acme.test?subject=App%20Error&body=Code%3A%201',
    )
  })
})
