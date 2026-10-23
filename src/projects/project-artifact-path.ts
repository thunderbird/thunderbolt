/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Provider tool-call IDs are opaque data, including any URL delimiters they contain. */
export const projectArtifactPath = (projectId: string, artifactId: string): string =>
  `/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifactId)}`
