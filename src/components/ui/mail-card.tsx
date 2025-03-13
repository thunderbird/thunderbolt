import { ReactNode } from 'react'

interface MailCardProps {
  from?: string
  to?: string
  date?: string
  content?: string | ReactNode
  footer?: ReactNode
  className?: string
}

export function MailCard(props: MailCardProps) {
  return (
    <div className={` bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md ${props.className ?? ''}`}>
      <div className="p-4">
        <div className="flex justify-between items-start">
          <div className="flex-1">
            {props.from && (
              <div className="flex items-baseline">
                <span className="w-12 text-sm font-medium text-primary dark:text-gray-400">From:</span>
                <span className="text-sm text-gray-900 dark:text-gray-100">{props.from}</span>
              </div>
            )}

            {props.to && (
              <div className="flex items-baseline mt-1">
                <span className="w-12 text-sm font-medium text-primary dark:text-gray-400">To:</span>
                <span className="text-sm text-gray-900 dark:text-gray-100">{props.to}</span>
              </div>
            )}
          </div>

          {props.date && <div className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap ml-4">{props.date}</div>}
        </div>
      </div>

      {props.content && (
        <>
          <div className="border-t border-gray-200 dark:border-gray-700" />
          <div className="p-4">
            <div className="text-sm text-gray-900 dark:text-gray-100">{typeof props.content === 'string' ? <p>{props.content}</p> : props.content}</div>
          </div>
        </>
      )}

      {props.footer && (
        <div className="px-4 py-3">
          <div className="flex flex-wrap items-center gap-2 justify-start">{props.footer}</div>
        </div>
      )}
    </div>
  )
}
