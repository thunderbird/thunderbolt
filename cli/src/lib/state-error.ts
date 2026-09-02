/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { providerRuntimeError, type ProviderRuntimeError } from '../provider-runtime/types.ts'

type StateError = Error & ProviderRuntimeError

/** Creates the shared error shape for invalid or newer persisted CLI state. */
export const createStateError = (
  subject: 'auth config' | 'config',
  code: 'config-invalid' | 'config-version-unsupported',
  path: string,
): StateError => {
  const unsupported = code === 'config-version-unsupported'
  const message = unsupported
    ? `${subject} at ${path} was written by a newer Thunderbolt CLI version`
    : `${subject} at ${path} is invalid`
  return providerRuntimeError(code, message)
}
