/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState } from 'react'

/** Whether a file's earlier versions are shown, and the action that shows or hides them. */
export const useCreatedFileVersionGroupState = () => {
  const [expanded, setExpanded] = useState(false)
  return { expanded, toggle: () => setExpanded((current) => !current) }
}
