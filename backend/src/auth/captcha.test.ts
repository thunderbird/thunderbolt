/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { createCaptchaVerifier } from './captcha'

describe('createCaptchaVerifier', () => {
  it("passes every request when the provider is 'none'", async () => {
    const verifier = createCaptchaVerifier({ captchaProvider: 'none' })
    expect(await verifier.verify(null, { headers: undefined })).toBe(true)
    expect(await verifier.verify('anything', { headers: new Headers() })).toBe(true)
  })

  it.each(['altcha', 'turnstile'] as const)('refuses to start with the unbuilt %s provider', (captchaProvider) => {
    expect(() => createCaptchaVerifier({ captchaProvider })).toThrow(`CAPTCHA_PROVIDER=${captchaProvider}`)
  })
})
