/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { FileSpreadsheet } from 'lucide-react'
import type { ReactNode } from 'react'

/** Shown in place of the grid when there is no grid to show: what happened, and what to do instead. */
export const PreviewNotice = ({ title, children }: { title: ReactNode; children: ReactNode }) => (
  <div className="flex flex-1 items-center justify-center p-6">
    <div className="flex max-w-xs flex-col items-center gap-2 text-center">
      <FileSpreadsheet className="size-8 text-muted-foreground" aria-hidden="true" />
      <p className="text-[length:var(--font-size-body)] font-medium text-foreground">{title}</p>
      <p className="text-[length:var(--font-size-sm)] text-muted-foreground">{children}</p>
    </div>
  </div>
)
