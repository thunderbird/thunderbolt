/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { useLingui } from '@lingui/react/macro'
import { Info } from 'lucide-react'
import type { ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

type FormFieldProps = {
  id: string
  label: ReactNode
  hint?: ReactNode
  /** Extra context behind an info icon beside the label, as the Skills form's Description has. */
  tooltip?: ReactNode
  error?: ReactNode
  className?: string
  children: ReactNode
}

/** The ids a field's input points `aria-describedby` at, so the hint and error are read with it. */
export const describedBy = (id: string, { hint, error }: { hint?: ReactNode; error?: ReactNode }) =>
  [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined

/** The info icon beside a label, whose tooltip says what the field is for. */
const LabelTooltip = ({ children }: { children: ReactNode }) => {
  const { t } = useLingui()
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={t`What is this for?`} className="text-muted-foreground hover:text-foreground">
          <Info size={14} strokeWidth={1.75} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-[202px]">
        {children}
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * A form label above its control, as the Skills form lays one out. The tooltip's icon sits beside
 * the label rather than inside it, so the button's name doesn't join the control's.
 */
export const FormLabel = ({
  htmlFor,
  tooltip,
  children,
}: {
  htmlFor: string
  tooltip?: ReactNode
  children: ReactNode
}) => {
  const label = (
    <label htmlFor={htmlFor} className="text-base text-foreground">
      {children}
    </label>
  )
  if (!tooltip) {
    return label
  }
  return (
    <div className="flex items-center gap-1.5">
      {label}
      <LabelTooltip>{tooltip}</LabelTooltip>
    </div>
  )
}

/** A labelled control with an optional hint and an inline error under it, laid out like the Skills form. */
export const FormField = ({ id, label, hint, tooltip, error, className, children }: FormFieldProps) => (
  <div className={cn('flex flex-col gap-2', className)}>
    <FormLabel htmlFor={id} tooltip={tooltip}>
      {label}
    </FormLabel>
    {children}
    {hint && (
      <p id={`${id}-hint`} className="text-[length:var(--font-size-xs)] text-muted-foreground">
        {hint}
      </p>
    )}
    {error && (
      <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
        {error}
      </p>
    )}
  </div>
)

/**
 * A titled group of controls with no single input to label, such as a picker whose trigger names
 * itself: the title looks like a field label without claiming one.
 */
export const FormGroup = ({ title, children }: { title: ReactNode; children: ReactNode }) => (
  <div role="group" aria-label={typeof title === 'string' ? title : undefined} className="flex flex-col gap-2">
    <span className="text-base text-foreground">{title}</span>
    {children}
  </div>
)
