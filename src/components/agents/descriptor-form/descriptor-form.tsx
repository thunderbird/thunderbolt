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
  type AgentFieldOption,
  type AgentSpec,
} from '@shared/agent-descriptors'
import { Button } from '@/components/ui/button'
import { FormFooter } from '@/components/ui/form-footer'
import { Input } from '@/components/ui/input'
import { ResponsiveModalCancel } from '@/components/ui/responsive-modal'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { submittableSpec } from './submittable-spec'
import { fieldOptions, fieldOptionsLoading, type OptionSources } from './option-sources'

type DescriptorFormProps = {
  descriptor: AgentDescriptor
  onSubmit: (spec: AgentSpec) => void | Promise<void>
  /** Dismiss the form (Cancel button); mirrors the connect form's onClose. */
  onCancel: () => void
  submitLabel?: string
  isSubmitting?: boolean
  /** A submit-time error (e.g. a failed deploy) shown next to the buttons. */
  error?: string | null
  /** Resolved `fetched` option sources (e.g. `account-models`); inline sources ignore this. */
  optionSources?: OptionSources
}

type FieldControlProps = {
  field: AgentField
  rhf: ControllerRenderProps<AgentSpec, string>
  options: AgentFieldOption[]
  isLoading: boolean
}

/** Render the control for a single field's widget. Unknown widgets degrade to a note. */
const FieldControl = ({ field, rhf, options, isLoading }: FieldControlProps) => {
  const value = typeof rhf.value === 'string' ? rhf.value : ''
  switch (field.widget) {
    case 'textarea':
      return <Textarea {...rhf} value={value} placeholder={field.placeholder} maxLength={field.maxLength} />
    case 'password':
      return (
        <Input {...rhf} value={value} type="password" placeholder={field.placeholder} maxLength={field.maxLength} />
      )
    case 'select':
    case 'option-cards': {
      if (isLoading) {
        return (
          <Select disabled>
            <SelectTrigger>
              <SelectValue placeholder="Loading…" />
            </SelectTrigger>
          </Select>
        )
      }
      if (options.length === 0) {
        return (
          <Select disabled>
            <SelectTrigger>
              <SelectValue placeholder="No models available" />
            </SelectTrigger>
          </Select>
        )
      }
      return (
        <Select value={value} onValueChange={rhf.onChange}>
          <SelectTrigger>
            <SelectValue placeholder={field.placeholder ?? 'Select an option'} />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )
    }
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
  onCancel,
  submitLabel = 'Deploy',
  isSubmitting = false,
  error,
  optionSources = {},
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
      <form onSubmit={handleSubmit} className="flex flex-1 flex-col">
        {descriptor.description && <p className="text-sm text-muted-foreground">{descriptor.description}</p>}
        <div className="grid grid-cols-1 gap-4 pt-4 pb-2">
          {fields.map((field) => (
            <FormField
              key={field.key}
              control={form.control}
              name={field.key}
              render={({ field: rhf }) => (
                <FormItem>
                  <FormLabel>{field.label}</FormLabel>
                  <FormControl>
                    <FieldControl
                      field={field}
                      rhf={rhf}
                      options={fieldOptions(field, optionSources)}
                      isLoading={fieldOptionsLoading(field, optionSources)}
                    />
                  </FormControl>
                  {field.helpText && <FormDescription>{field.helpText}</FormDescription>}
                  <FormMessage />
                </FormItem>
              )}
            />
          ))}
        </div>
        <FormFooter>
          {error && (
            <p role="alert" className="min-w-0 flex-1 truncate text-[length:var(--font-size-sm)] text-destructive">
              {error}
            </p>
          )}
          <ResponsiveModalCancel onClick={onCancel} />
          <Button type="submit" isLoading={isSubmitting} loadingLabel="Deploying…" disabled={isSubmitting}>
            {submitLabel}
          </Button>
        </FormFooter>
      </form>
    </Form>
  )
}
