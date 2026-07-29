/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Renders an {@link AgentDescriptor} as a form and produces a validated spec.
 * The descriptor owns the structure (steps → fields → widgets, `visibleWhen`);
 * react-hook-form owns state, with `zodResolver(specSchemaForDescriptor)` — the
 * same validator the backend re-runs — as the single source of validation truth.
 */

import { useForm, type ControllerRenderProps, type Resolver } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import {
  defaultSpec,
  specSchemaForDescriptor,
  visibleFields,
  type AgentDescriptor,
  type AgentField,
  type AgentSpec,
} from '@shared/agent-descriptors'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { submittableSpec } from './submittable-spec'

type DescriptorFormProps = {
  descriptor: AgentDescriptor
  onSubmit: (spec: AgentSpec) => void | Promise<void>
  submitLabel?: string
  isSubmitting?: boolean
  /** A submit-time error (e.g. a failed deploy) shown above the button. */
  error?: string | null
}

const inlineOptions = (field: AgentField) => (field.source?.kind === 'inline' ? field.source.options : [])

/** Render the control for a single field's widget. Unknown widgets degrade to a note. */
const FieldControl = ({ field, rhf }: { field: AgentField; rhf: ControllerRenderProps<AgentSpec, string> }) => {
  const value = typeof rhf.value === 'string' ? rhf.value : ''
  switch (field.widget) {
    case 'textarea':
      return <Textarea {...rhf} value={value} placeholder={field.placeholder} maxLength={field.maxLength} />
    case 'password':
      return (
        <Input {...rhf} value={value} type="password" placeholder={field.placeholder} maxLength={field.maxLength} />
      )
    case 'select':
    case 'option-cards':
      return (
        <Select value={value} onValueChange={rhf.onChange}>
          <SelectTrigger>
            <SelectValue placeholder={field.placeholder ?? 'Select an option'} />
          </SelectTrigger>
          <SelectContent>
            {inlineOptions(field).map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )
    case 'text':
      return <Input {...rhf} value={value} placeholder={field.placeholder} maxLength={field.maxLength} />
    default:
      // gallery / file-upload aren't rendered yet — degrade gracefully.
      return (
        <p className="text-[length:var(--font-size-sm)] text-muted-foreground">This field type isn’t supported yet.</p>
      )
  }
}

export const DescriptorForm = ({
  descriptor,
  onSubmit,
  submitLabel = 'Deploy',
  isSubmitting = false,
  error,
}: DescriptorFormProps) => {
  const form = useForm<AgentSpec>({
    // zod v4's resolver infers `Record<string, unknown>`; the descriptor's spec
    // is the narrower `AgentSpec`. Cast is the sanctioned workaround (see plan notes).
    resolver: zodResolver(specSchemaForDescriptor(descriptor)) as Resolver<AgentSpec>,
    defaultValues: defaultSpec(descriptor),
  })

  // Recompute visibility from live values so `visibleWhen` fields toggle in place.
  const fields = visibleFields(descriptor, form.watch())

  const handleSubmit = form.handleSubmit((values) => onSubmit(submittableSpec(descriptor, values)))

  return (
    <Form {...form}>
      <form onSubmit={handleSubmit} className="space-y-4">
        {descriptor.description && (
          <p className="text-[length:var(--font-size-sm)] text-muted-foreground">{descriptor.description}</p>
        )}
        {fields.map((field) => (
          <FormField
            key={field.key}
            control={form.control}
            name={field.key}
            render={({ field: rhf }) => (
              <FormItem>
                <FormLabel>{field.label}</FormLabel>
                <FormControl>
                  <FieldControl field={field} rhf={rhf} />
                </FormControl>
                {field.helpText && <FormDescription>{field.helpText}</FormDescription>}
                <FormMessage />
              </FormItem>
            )}
          />
        ))}
        {error && <p className="text-[length:var(--font-size-sm)] text-destructive">{error}</p>}
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Deploying…' : submitLabel}
        </Button>
      </form>
    </Form>
  )
}
