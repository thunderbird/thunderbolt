/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Avoid JavaScriptCore's HasOwnPropertyCache JIT path on desktop WebKit.
 * M6 / macOS 27.2.1 emits reversed base/index loads that fault with EXC_ARM_CPA_FAIL.
 * Keep this function self-contained: the build embeds it before page and worker code.
 */
export const installWebKitOwnPropertyCompat = (userAgent: string): void => {
  'use strict'

  // WKWebView freezes its OS/engine version in this UA, so it cannot identify a fixed OS release.
  if (
    !/Macintosh/.test(userAgent) ||
    !/AppleWebKit\//.test(userAgent) ||
    /(?:Chrome|Chromium|Edg|OPR)\//.test(userAgent)
  ) {
    return
  }

  const getDescriptor = Object.getOwnPropertyDescriptor
  const ownKeys = Reflect.ownKeys
  const installed = Symbol.for('thunderbolt.webkitOwnPropertyCompat')
  if (getDescriptor(Object.prototype.hasOwnProperty, installed)?.value) {
    return
  }

  const methods = {
    hasOwnProperty(this: unknown, value: PropertyKey): boolean {
      // The prototype method coerces the key BEFORE the receiver (Object.hasOwn does the reverse).
      // A computed property preserves ToPropertyKey's string hint and symbol-valued conversions.
      const key = typeof value === 'string' || typeof value === 'symbol' ? value : ownKeys({ [value]: null })[0]
      return getDescriptor(this, key) !== undefined
    },
    hasOwn(object: unknown, key: PropertyKey): boolean {
      return getDescriptor(object, key) !== undefined
    },
  }

  Object.defineProperty(methods.hasOwnProperty, installed, { value: true })
  Object.defineProperty(Object.prototype, 'hasOwnProperty', {
    value: methods.hasOwnProperty,
    configurable: true,
    writable: true,
    enumerable: false,
  })
  Object.defineProperty(Object, 'hasOwn', {
    value: methods.hasOwn,
    configurable: true,
    writable: true,
    enumerable: false,
  })
}
