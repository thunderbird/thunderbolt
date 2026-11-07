/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Fixture runners accept only explicit local HTTP origins, never credentials or an ignored URL suffix. */
export const localOrigin = (value: string): string => {
  const url = new URL(value)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('Fixture runners require a loopback HTTP(S) origin without credentials, path, query or fragment')
  }
  return url.origin
}

/** Keep artifact labels within the selected output directory. */
export const validateLabel = (label: string): void => {
  if (!/^[a-zA-Z0-9_-]+$/.test(label)) {
    throw new Error('--label must contain letters, numbers, underscores or hyphens')
  }
}

/** Reject unsafe counts before allocating fixtures or starting a browser. */
export const positiveInteger = (name: string, value: string | number): number => {
  const count = Number(value)
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error(`${name} must be a positive safe integer`)
  }
  return count
}
