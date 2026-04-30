/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { formatDate } from '@/lib/utils'
import dayjs from 'dayjs'
import { useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

export const DatetimePreview = ({ timestamp }: { timestamp: number }) => {
  const [isOpen, setIsOpen] = useState(false)

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger onClick={(e) => e.stopPropagation()} className="text-sm hover:underline cursor-pointer">
        {formatDate(timestamp)}
      </PopoverTrigger>
      <PopoverContent className="w-auto p-2">
        <span className="text-sm">{dayjs(timestamp).format('dddd, MMMM D, YYYY [at] h:mm A')}</span>
      </PopoverContent>
    </Popover>
  )
}
