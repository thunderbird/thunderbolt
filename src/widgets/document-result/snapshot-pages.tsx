/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type DocumentSnapshot } from './snapshot'
import { useSnapshotPagesState } from './use-snapshot-pages-state'

type SnapshotPagesProps = {
  title: string
  snapshot: Extract<DocumentSnapshot, { kind: 'pages' }>
}

/**
 * A document's pages or a deck's slides in a frame with `sandbox=""` that fills the panel and scrolls them itself.
 * Pages wider than the panel scale down to its width with the fit style; in a browser where that style does not draw
 * them as they are, such as Safari, the frame keeps the pages' width and is drawn smaller. On a phone, pages that
 * reflow take its width instead, so their text stays readable.
 */
export const SnapshotPages = ({ title, snapshot }: SnapshotPagesProps) => {
  const { ref, srcDoc, size } = useSnapshotPagesState(snapshot)
  return (
    <div ref={ref} className="relative min-h-0 flex-1 overflow-hidden">
      <iframe
        title={title}
        sandbox=""
        srcDoc={srcDoc}
        className="absolute left-0 top-0 origin-top-left border-0"
        style={size}
      />
    </div>
  )
}
