/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { ArrowUpRight, Pencil } from 'lucide-react'
import ReactMarkdown, { type Components } from 'react-markdown'
import { AppLogo } from '@/components/app-logo'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export type BuiltInMemoryCardContent = {
  content: string
  isLoading: boolean
  onEdit: () => void
  onView: () => void
}

type BuiltInMemoryCardProps = {
  memory: BuiltInMemoryCardContent
  selected: boolean
  disabled: boolean
  onSelect: (id: string) => void
}

// Preview links cannot compete with the card action, and saved images must never make network requests.
const previewComponents: Components = {
  a: ({ children }) => <span>{children}</span>,
  img: ({ alt }) => <span>{alt}</span>,
}

/** Show the retained built-in document independently of the selected memory provider. */
export const BuiltInMemoryCard = ({ memory, selected, disabled, onSelect }: BuiltInMemoryCardProps) => {
  const { t } = useLingui()
  const unavailable = disabled || memory.isLoading
  return (
    <div
      className={cn('relative p-4 transition-colors', selected && 'bg-accent/40', !disabled && 'hover:bg-accent/30')}
    >
      <div className="pointer-events-none relative flex items-center gap-3">
        <span className="pointer-events-auto relative z-10 size-4 shrink-0">
          <input
            type="radio"
            name="memory-provider"
            value="builtin"
            checked={selected}
            disabled={disabled}
            onChange={() => onSelect('builtin')}
            aria-label={t`Built-in`}
            className="m-0 block size-4 cursor-pointer appearance-none rounded-full border border-border-strong bg-background checked:border-transparent checked:bg-brand checked:bg-origin-border checked:[background-image:var(--gradient-brand)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed forced-colors:appearance-auto"
          />
          {selected && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute left-1/2 top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand-foreground forced-colors:hidden"
            />
          )}
        </span>
        <span className="flex size-8 shrink-0 items-center justify-center">
          <AppLogo size={24} alt="" />
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-medium">
            <Trans>Built-in</Trans>
          </span>
          <span className="block text-xs text-muted-foreground">
            <Trans>Synced across your devices</Trans>
          </span>
        </span>
      </div>
      <button
        type="button"
        aria-label={t`View full memory`}
        onClick={memory.onView}
        disabled={unavailable}
        className="absolute inset-0 cursor-pointer rounded-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:cursor-default"
      />
      <div className="pointer-events-none relative -mx-4 my-4 h-px bg-border/60" />
      <div className="pointer-events-none relative max-h-28 overflow-hidden break-words text-sm leading-6 text-muted-foreground/80 [&_:is(h1,h2,h3,h4,h5,h6)]:font-medium [&_ol]:list-decimal [&_ol]:pl-5 [&_p+p]:mt-1 [&_pre]:whitespace-pre-wrap [&_ul]:list-disc [&_ul]:pl-5">
        {memory.isLoading ? (
          <span role="status">
            <Trans>Loading memory…</Trans>
          </span>
        ) : memory.content ? (
          <ReactMarkdown components={previewComponents}>{memory.content}</ReactMarkdown>
        ) : (
          <p>
            <Trans>No memory yet. Click Edit or ask your agent to remember something.</Trans>
          </p>
        )}
      </div>
      <div className="pointer-events-none relative mt-4 flex flex-wrap items-center justify-between gap-2">
        <span aria-hidden="true" className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <Trans>View full memory</Trans>
          <ArrowUpRight className="size-3" />
        </span>
        <div className="pointer-events-auto relative z-10 flex items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="pointer-events-auto relative z-10"
            onClick={memory.onEdit}
            disabled={unavailable}
          >
            <Pencil className="size-4" aria-hidden="true" />
            <Trans>Edit</Trans>
          </Button>
        </div>
      </div>
    </div>
  )
}
