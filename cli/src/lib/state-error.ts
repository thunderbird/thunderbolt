/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

type StateErrorCode = 'config-invalid' | 'config-version-unsupported'
type StateError = Error & { readonly code: StateErrorCode; readonly message: string }

/** Creates the shared error shape for invalid or newer persisted CLI state. */
export const createStateError = (subject: 'auth config' | 'config', code: StateErrorCode, path: string): StateError => {
  const unsupported = code === 'config-version-unsupported'
  const message = unsupported
    ? `${subject} at ${path} was written by a newer Thunderbolt CLI version`
    : `${subject} at ${path} is invalid`
  return Object.assign(new Error(message), { code, message })
}
