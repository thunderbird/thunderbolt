/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

declare module '@ungap/structured-clone' {
  type StructuredCloneOptions = {
    transfer?: readonly Transferable[]
    json?: boolean
    lossy?: boolean
  }

  const structuredClone: <T>(value: T, options?: StructuredCloneOptions) => T
  export default structuredClone
}
