/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Share the lazy loader with the project menu so it warms on intent, before the modal opens. */
export const loadProjectArtifactsDialog = () => import('./project-artifacts-dialog-content')
