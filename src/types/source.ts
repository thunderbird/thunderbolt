/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The shape lives in the shared contract because the cloud runner produces the
// same entries on its tool results; re-exported here so app imports stay put.
export type { SourceMetadata } from '@shared/tools/pro-tools-contract'
