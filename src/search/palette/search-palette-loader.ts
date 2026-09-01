/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Load the palette subtree (cmdk, FTS, registry, icons) separately from the entry bundle. */
export const loadSearchPalette = () => import('./search-palette')
