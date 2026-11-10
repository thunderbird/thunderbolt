/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Keep file drops from replacing the app document while preserving drop-target handlers. */
export const installFileDropNavigationPrevention = (target: Document = document) => {
  const preventNavigation = (event: DragEvent) => {
    if (event.dataTransfer?.types.includes('Files')) {
      event.preventDefault()
    }
  }

  target.addEventListener('dragover', preventNavigation)
  target.addEventListener('drop', preventNavigation)
  return () => {
    target.removeEventListener('dragover', preventNavigation)
    target.removeEventListener('drop', preventNavigation)
  }
}
