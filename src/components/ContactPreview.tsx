/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

// @todo re-implement types
export const EmailAddressPreview = ({ emailAddress }: { emailAddress: any }) => {
  if (!emailAddress.name) {
    return <span className="text-sm">{emailAddress.address}</span>
  }

  return (
    <Popover>
      <PopoverTrigger onClick={(e) => e.stopPropagation()} className="text-sm hover:underline cursor-pointer">
        {emailAddress.name}
      </PopoverTrigger>
      <PopoverContent className="w-auto p-2">
        <span className="text-sm">{emailAddress.address}</span>
      </PopoverContent>
    </Popover>
  )
}
