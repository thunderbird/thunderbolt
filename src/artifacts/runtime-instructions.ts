/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Both HTML publication tools use the same opaque-origin iframe runtime. */
export const artifactRuntimeInstructions =
  'HTML artifacts run in an opaque-origin sandbox: localStorage, sessionStorage, IndexedDB, and cookies are unavailable. Saved snapshots and pins preserve HTML source, not runtime state or user-entered data. Do not claim persistence by catching storage failures and falling back to memory. Offer explicit JSON copy/paste export/import if that meets the request; otherwise explain the persistence limitation before proceeding.'
