/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createContext } from 'react'

/** A transcript beside a project canvas renders a shortcut instead of a second live artifact. */
export const ArtifactCanvasContext = createContext<{ toolCallId: string; reveal: () => void } | null>(null)
