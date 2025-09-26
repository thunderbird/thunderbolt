import { Calendar, CloudSun, Inbox, Loader2, Rss, Search } from 'lucide-react'

import { Avatar, AvatarFallback } from '../ui/avatar'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

// This is sample data
const data = [
  {
    name: 'Get-Current-Weather',
    title: 'Get Current Weather',
    duration: 10, // seconds
    loading: false,
    icon: CloudSun,
  },
  {
    name: 'Search',
    title: 'Search',
    duration: 7, // seconds
    loading: true,
    icon: Search,
  },
  {
    name: 'Google-Check-Inbox',
    title: 'Google Check Inbox',
    duration: 9, // seconds
    loading: true,
    icon: Inbox,
  },
  {
    name: 'Google-Check-Calendar',
    title: 'Google Check Calendar',
    duration: 9, // seconds
    loading: true,
    icon: Calendar,
  },
  {
    name: 'Fetch-Content1',
    title: 'Fetch Content',
    duration: 12, // seconds
    loading: false,
    icon: Rss,
  },
  {
    name: 'Fetch-Content2',
    title: 'Fetch Content',
    duration: 12, // seconds
    loading: false,
    icon: Rss,
  },
  {
    name: 'Fetch-Content3',
    title: 'Fetch Content',
    duration: 12, // seconds
    loading: false,
    icon: Rss,
  },
  {
    name: 'T1',
    title: 'Tool 1',
    duration: 12, // seconds
    loading: false,
  },
  {
    name: 'T2',
    title: 'Tool 2',
    duration: 12, // seconds
    loading: true,
  },
]

export function ToolGroup() {
  return (
    <div className="*:data-[slot=avatar]:ring-background flex -space-x-2 *:data-[slot=avatar]:ring-2 *:data-[slot=avatar]:grayscale p-1">
      {data.map(({ icon: Icon, name, loading, title }) => (
        <Tooltip>
          <TooltipTrigger asChild>
            <Avatar key={name} className="border-2 border-background size-11">
              <AvatarFallback>
                {loading ? (
                  <Loader2 className="h-5 w-5 animate-spin text-blue-600 dark:text-blue-400" />
                ) : Icon ? (
                  <Icon className="size-5" />
                ) : (
                  name
                )}
              </AvatarFallback>
            </Avatar>
          </TooltipTrigger>
          <TooltipContent>
            <p>{title}</p>
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}
