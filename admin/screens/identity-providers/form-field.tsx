/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import type { ReactNode } from 'react'
import { DetailField } from '@/components/settings/detail-field'
import { Label } from '@/components/ui/label'

type FormFieldProps = {
  id: string
  label: ReactNode
  hint?: ReactNode
  error?: ReactNode
  children: ReactNode
}

/** The ids a field's input points `aria-describedby` at, so the hint and error are read with it. */
export const describedBy = (id: string, { hint, error }: { hint?: ReactNode; error?: ReactNode }) =>
  [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined

/** A labelled input with an optional hint and an inline error under it. */
export const FormField = ({ id, label, hint, error, children }: FormFieldProps) => (
  <DetailField label={<Label htmlFor={id}>{label}</Label>}>
    {children}
    {hint && (
      <p id={`${id}-hint`} className="text-[length:var(--font-size-sm)] text-muted-foreground">
        {hint}
      </p>
    )}
    {error && (
      <p id={`${id}-error`} role="alert" className="text-[length:var(--font-size-sm)] text-destructive">
        {error}
      </p>
    )}
  </DetailField>
)

/** A value shown, never edited, with why when it matters. */
export const ReadOnlyField = ({ label, value, hint }: { label: ReactNode; value: ReactNode; hint?: ReactNode }) => (
  <DetailField label={label}>
    <code className="block break-all rounded-md bg-muted px-2 py-1 font-mono text-[length:var(--font-size-sm)]">
      {value}
    </code>
    {hint && <p className="text-[length:var(--font-size-sm)] text-muted-foreground">{hint}</p>}
  </DetailField>
)
