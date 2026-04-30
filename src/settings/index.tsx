/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type ReactNode } from 'react'

export default function Settings({ children }: { children?: ReactNode }) {
  return (
    <>
      <div className="flex flex-col gap-4 p-4 w-full">{children}</div>
    </>
  )
}
