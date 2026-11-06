/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Wire contract between the backend tinfoil proxy and the frontend error
 * classifier: the proxy returns these exact strings as the 504 body (headers
 * timeout) and the mid-stream idle error message, and the frontend matches
 * them to classify the failure as a timeout. Shared so a reword cannot
 * silently break classification on the other side of the boundary.
 */
export const tinfoilUpstreamTimeoutMessage = 'tinfoil upstream timeout'
export const tinfoilUpstreamIdleTimeoutMessage = 'tinfoil upstream idle timeout'
