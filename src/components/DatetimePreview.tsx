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
