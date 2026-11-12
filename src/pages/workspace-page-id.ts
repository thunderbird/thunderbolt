/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { v5 as uuidv5 } from 'uuid'

/** Keep a file's page identity stable within its owner and execution environment. */
export const workspacePageId = (scope: string, cwd: string, path: string): string => {
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(cwd)
  const filename = windows ? path.replaceAll('\\', '/') : path
  const directory = windows ? cwd.replaceAll('\\', '/') : cwd
  const absolute = filename.startsWith('/') || /^[a-z]:\//i.test(filename) ? filename : `${directory}/${filename}`
  const segments = absolute.split('/').reduce<string[]>((parts, segment) => {
    if (segment === '..') {
      parts.pop()
    } else if (segment && segment !== '.') {
      parts.push(segment)
    }
    return parts
  }, [])
  return `file-${uuidv5(JSON.stringify([scope, segments.join('/')]), '88199f3d-664d-4be2-aecd-bb802867a412')}`
}
