/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import type { UseFormReturn } from 'react-hook-form'
import { z } from 'zod'
import { IconPicker } from './icon-picker'

/** Slugify any text into a URL-safe shape: lowercase a–z 0–9 hyphens. */
export const slugifyWorkspaceName = (input: string): string =>
  input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)

export const workspaceFormSchema = z.object({
  // Field is named `workspaceName` (not `name`) so the resulting `<input name="...">`
  // doesn't trigger Chrome/Safari's person-name autofill heuristic.
  workspaceName: z.string().refine((value) => value.trim().length > 0, { message: 'Workspace name is required' }),
  icon: z.string().nullable(),
})

export type WorkspaceFormValues = z.infer<typeof workspaceFormSchema>

type WorkspaceFormFieldsProps = {
  form: UseFormReturn<WorkspaceFormValues>
  /** First-letter fallback the icon picker shows when no icon is set. */
  iconPlaceholder?: string
  /** Fires on every keystroke into name. Wire to a debounced save. */
  onDebouncedChange?: () => void
  /** Fires on name blur and on icon select/remove. Wire to immediate save. */
  onCommit?: () => void
  /** When true, all inputs render disabled — read-only view for callers who
   *  lack edit permission (e.g. non-admin members on the General settings page). */
  disabled?: boolean
}

/**
 * Shared workspace form fields — name + icon picker. The slug is derived from
 * the name at save time by the caller (no user-facing URL input).
 */
export const WorkspaceFormFields = ({
  form,
  iconPlaceholder,
  onDebouncedChange,
  onCommit,
  disabled = false,
}: WorkspaceFormFieldsProps) => (
  <>
    <FormField
      control={form.control}
      name="workspaceName"
      render={({ field }) => (
        <FormItem>
          <FormLabel className="text-sm font-medium">Workspace name</FormLabel>
          <FormControl>
            <Input
              inputSize="lg"
              placeholder="e.g. Engineering"
              {...field}
              disabled={disabled}
              onChange={(e) => {
                field.onChange(e)
                onDebouncedChange?.()
              }}
              onBlur={() => {
                field.onBlur()
                onCommit?.()
              }}
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />

    <FormField
      control={form.control}
      name="icon"
      render={({ field }) => (
        <FormItem>
          <FormLabel className="text-sm font-medium">Icon (optional)</FormLabel>
          <p className="text-sm text-muted-foreground -mt-1">
            Upload an image or pick an emoji. This icon will appear in your sidebar and notifications.
          </p>
          <FormControl>
            <IconPicker
              value={field.value}
              onChange={(next) => {
                field.onChange(next)
                onCommit?.()
              }}
              placeholder={iconPlaceholder}
              disabled={disabled}
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  </>
)
