/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Pi 0.82.1 has no Opus 5.5 entry; borrow Opus 5's metadata while keeping the wire slug. */
export const managedAnthropicCatalogId = (modelId: string): string =>
  modelId === 'opus-5-5' ? 'claude-opus-5' : `claude-${modelId}`
