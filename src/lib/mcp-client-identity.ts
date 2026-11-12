/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const endpoints = new WeakMap<object, string>()

/** Bind the actual transport endpoint once; editable server metadata cannot relabel an existing client. */
export const bindMcpClientEndpoint = (client: object, url: string): void => {
  if (!endpoints.has(client)) {
    endpoints.set(client, url)
  }
}

/** Read immutable connection provenance, including clients returned by a later reconnect. */
export const getMcpClientEndpoint = (client: object): string | undefined => endpoints.get(client)
