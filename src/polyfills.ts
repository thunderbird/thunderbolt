/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Polyfills that need to run before the rest of the application code.
 *
 * Currently includes:
 *   • `crypto.randomUUID` (missing on older/embedded WebKit/Gecko engines such as
 *     Firefox Focus or legacy Safari versions.)
 */

// @ts-ignore – we’re intentionally augmenting the global `crypto` object
;(() => {
  // Only polyfill when necessary and when secure random is available.
  if (
    typeof crypto !== 'undefined' &&
    typeof (crypto as any).randomUUID === 'undefined' &&
    typeof crypto.getRandomValues === 'function'
  ) {
    /**
     * Generates a RFC 4122 version-4 UUID using `crypto.getRandomValues`.
     * Implementation adapted from the WHATWG spec reference algorithm.
     */
    const byteToHex: string[] = []
    for (let i = 0; i < 256; i++) {
      byteToHex.push((i + 0x100).toString(16).substring(1))
    }

    ;(crypto as any).randomUUID = (): string => {
      const rnds = new Uint8Array(16)
      crypto.getRandomValues(rnds)

      // Per RFC 4122 §4.4 set bits for version and `clock_seq_hi_and_reserved`
      rnds[6] = (rnds[6] & 0x0f) | 0x40 // version = 4
      rnds[8] = (rnds[8] & 0x3f) | 0x80 // variant = RFC 4122

      return (
        byteToHex[rnds[0]] +
        byteToHex[rnds[1]] +
        byteToHex[rnds[2]] +
        byteToHex[rnds[3]] +
        '-' +
        byteToHex[rnds[4]] +
        byteToHex[rnds[5]] +
        '-' +
        byteToHex[rnds[6]] +
        byteToHex[rnds[7]] +
        '-' +
        byteToHex[rnds[8]] +
        byteToHex[rnds[9]] +
        '-' +
        byteToHex[rnds[10]] +
        byteToHex[rnds[11]] +
        byteToHex[rnds[12]] +
        byteToHex[rnds[13]] +
        byteToHex[rnds[14]] +
        byteToHex[rnds[15]]
      )
    }
  }
})()
