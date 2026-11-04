/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { ReactNode } from 'react'

/** Shared error surface for failed cloud operations; failures remain actionable. */
export const CloudError = ({ error }: { error: unknown }) =>
  error ? (
    <Alert variant="destructive">
      <AlertDescription>
        {error instanceof Error ? error.message : <Trans>The request failed. Please try again.</Trans>}
      </AlertDescription>
    </Alert>
  ) : null

export const CloudField = ({ label, children }: { label: ReactNode; children: ReactNode }) => (
  <label className="flex flex-col gap-2 text-sm">
    <span className="font-medium">{label}</span>
    {children}
  </label>
)

export const CloudTabs = <T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { id: T; label: string }[]
  onChange: (value: T) => void
}) => (
  <div className="rounded-xl bg-muted p-0.75">
    <div className="relative flex">
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 rounded-lg bg-background shadow-xs transition-[inset-inline-start] duration-200 ease-out motion-reduce:transition-none"
        style={{
          width: `${100 / options.length}%`,
          insetInlineStart: `${(options.findIndex((option) => option.id === value) * 100) / options.length}%`,
        }}
      />
      {options.map((option) => (
        <Button
          key={option.id}
          size="sm"
          variant="ghost"
          className={cn(
            'relative min-w-0 flex-1 rounded-lg text-muted-foreground',
            value === option.id && 'text-foreground hover:bg-transparent dark:hover:bg-transparent',
          )}
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  </div>
)
