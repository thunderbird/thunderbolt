/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Create a per-test sequence of distinct eight-digit sign-in codes. */
export const createOtpGenerator = () => {
  let nextCode = 0
  return () => String(++nextCode).padStart(8, '0')
}
