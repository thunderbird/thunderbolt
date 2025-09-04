import { useState, Children, isValidElement, cloneElement, type ReactNode, type ReactElement } from 'react'

interface MailCardProps {
  id: string // Unique identifier for each card
  from?: string
  to?: string
  date?: string
  content?: string | ReactNode
  footer?: ReactNode
  className?: string
  isContentVisible?: boolean
  defaultVisible?: boolean
  onToggle?: (id: string) => void // Callback when card is toggled
}

export function MailCard(props: MailCardProps) {
  const handleToggle = () => {
    if (props.onToggle) {
      props.onToggle(props.id)
    }
  }

  return (
    <div
      className={`bg-white dark:bg-gray-800 ${props.isContentVisible ? 'border-green-500' : 'border-gray-200 dark:border-gray-700'} border rounded-md ${props.className ?? ''}`}
    >
      <div className={`p-4  cursor-pointer`} onClick={handleToggle}>
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

          <div className="flex items-center">
            {props.date && (
              <div className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">{props.date}</div>
            )}
          </div>
        </div>
      </div>
      {props.isContentVisible && <div className="h-px bg-gray-200 dark:bg-gray-700" />}

      <div
        style={{
          display: 'grid',
          gridTemplateRows: props.isContentVisible ? '1fr' : '0fr',
          transition: 'grid-template-rows 300ms ease-in-out',
          position: 'relative',
          zIndex: 1,
        }}
      >
        <div className="overflow-hidden">
          {props.content && (
            <>
              <div className="dark:border-gray-700" />
              <div className="p-4">
                <div className="text-sm text-gray-900 dark:text-gray-100">
                  {typeof props.content === 'string' ? <p>{props.content}</p> : props.content}
                </div>
              </div>
            </>
          )}
        </div>

        {props.footer && (
          <div className="px-4 py-3">
            <div className="flex flex-wrap items-center gap-2 justify-start">{props.footer}</div>
          </div>
        )}
      </div>
    </div>
  )
}

// Create a container component to manage the accordion behavior
interface MailCardListProps {
  children: ReactElement<MailCardProps>[] | ReactElement<MailCardProps>
}

export function MailCardList({ children }: MailCardListProps) {
  const [activeCardId, setActiveCardId] = useState<string | null>(null)

  const enhancedChildren = Children.map(children, (child) => {
    if (isValidElement<MailCardProps>(child)) {
      return cloneElement(child, {
        isContentVisible: child.props.id === activeCardId,
        onToggle: (id: string) => {
          setActiveCardId((currentId) => (currentId === id ? null : id))
        },
      })
    }
    return child
  })

  return <div className="space-y-4">{enhancedChildren}</div>
}
