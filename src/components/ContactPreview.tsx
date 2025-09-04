'use client'

import type { EmailAddress } from '@/types'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

export function EmailAddressPreview({ emailAddress }: { emailAddress: EmailAddress }) {
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
