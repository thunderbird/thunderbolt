/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AnimatePresence, m } from 'framer-motion'
import { Check, Pencil } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { SkillFormMode } from './use-skill-form-state'

type SkillSlugFieldProps = {
  mode: SkillFormMode
  slug: string
  error?: string | null
  onChange: (slug: string) => void
}

/** Displays an existing skill slug as text until the user chooses to edit it. */
export const SkillSlugField = ({ mode, slug, error, onChange }: SkillSlugFieldProps) => {
  const [isEditingSlug, setIsEditingSlug] = useState(false)
  const isCreateMode = mode === 'create'

  const input = (
    <div className="relative min-w-0 flex-1">
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 select-none text-[length:var(--font-size-body)] text-muted-foreground md:left-2 md:text-xs md:text-muted-foreground/70"
      >
        /
      </span>
      <Input
        id="skill-slug"
        autoFocus={!isCreateMode}
        placeholder="daily-brief"
        value={slug}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        className={cn(
          'pl-7 text-foreground md:h-7 md:rounded-md md:border-transparent md:bg-transparent md:pl-4 md:pr-2 md:!text-xs md:text-muted-foreground md:shadow-none',
          'md:hover:border-border md:focus-visible:border-border-strong md:focus-visible:text-foreground',
          'md:dark:bg-transparent md:dark:hover:bg-transparent',
        )}
      />
    </div>
  )

  return (
    <>
      <div className="mt-1 flex flex-col items-stretch gap-2 md:flex-row md:items-center md:gap-1.5">
        <label
          htmlFor={isCreateMode || isEditingSlug ? 'skill-slug' : undefined}
          className="text-base text-foreground md:shrink-0 md:text-xs md:text-muted-foreground"
        >
          Slug
        </label>
        {isCreateMode ? (
          input
        ) : (
          <div className="flex min-h-[var(--min-touch-height)] min-w-0 flex-1 items-center gap-1">
            <AnimatePresence initial={false} mode="popLayout">
              {isEditingSlug ? (
                <m.div
                  key="slug-input"
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -8 }}
                  className="min-w-0 flex-1"
                >
                  {input}
                </m.div>
              ) : (
                <m.span
                  key="slug-value"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="min-w-0 truncate text-[length:var(--font-size-body)] text-foreground"
                >
                  /{slug}
                </m.span>
              )}
            </AnimatePresence>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="min-h-[var(--min-touch-height)] min-w-[var(--min-touch-height)] shrink-0 rounded-md text-muted-foreground md:min-h-0 md:min-w-0"
              onClick={() => setIsEditingSlug((isEditing) => !isEditing)}
              aria-label={isEditingSlug ? 'Finish editing slug' : 'Edit slug'}
            >
              {isEditingSlug ? <Check /> : <Pencil />}
            </Button>
          </div>
        )}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </>
  )
}
