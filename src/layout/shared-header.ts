/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Expanded pages render their own header; all other routes use the app header. */
export const sharedHeaderHasControls = (pathname: string): boolean => !pathname.startsWith('/pages/')
