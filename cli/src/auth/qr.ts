/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Best-effort terminal QR of the device-grant verification URL. Purely a
 * convenience for scanning with a phone — the printed link + code are always the
 * authoritative path — so it degrades to nothing when the output isn't an
 * interactive terminal or is too narrow to hold a QR legibly.
 */

import { generate } from 'qrcode-terminal'

/** Terminal capabilities that gate whether a QR is worth rendering. */
export type QrEnv = {
  readonly isTty: boolean
  readonly columns: number
}

/** Minimum terminal width to attempt a (small-mode) QR; below this, link-only. */
const minQrColumns = 80

/**
 * Decide whether a terminal QR should be rendered: only on an interactive TTY
 * wide enough to hold one. This is the tested fallback decision; the render
 * itself is not unit-tested.
 *
 * @param env - the terminal's TTY flag and column count
 */
export const shouldRenderQr = (env: QrEnv): boolean => env.isTty && env.columns >= minQrColumns

/**
 * Render a compact QR of `text` to `print`. Callers gate this behind
 * {@link shouldRenderQr}, which is where the "can't render → link-only"
 * degradation lives; a bounded verification URL always fits within QR capacity,
 * so this stays a straight render with no error-swallowing.
 *
 * @param text - the URL to encode (the verification_uri_complete)
 * @param print - line sink (defaults to `console.log`)
 */
export const renderTerminalQr = (text: string, print: (line: string) => void = console.log): void => {
  generate(text, { small: true }, (qr) => print(qr))
}
