/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Isolate current SDK discovery and attestation, plus the v1 endpoint in frozen performance baselines. */
export const isTinfoilAttestationRequest = (url: URL): boolean =>
  (url.hostname === 'atc.tinfoil.sh' && ['/attestation', '/routers'].includes(url.pathname)) ||
  (url.hostname.endsWith('.tinfoil.sh') && url.pathname === '/.well-known/tinfoil-attestation')
