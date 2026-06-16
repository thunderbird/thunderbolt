/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { useState } from 'react'
import type { UseFormReturn } from 'react-hook-form'
import { z } from 'zod'
import { IconPicker } from './icon-picker'

export const workspaceSlugMaxLength = 50

/** Slugify any text into a URL-safe shape: lowercase a–z 0–9 hyphens. */
export const slugifyWorkspaceName = (input: string): string =>
  input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, workspaceSlugMaxLength)

/** Allow lowercase a–z 0–9 and hyphens to flow through the slug input live. */
export const sanitizeWorkspaceSlugInput = (raw: string): string =>
  raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, workspaceSlugMaxLength)

/** Strip protocol from the cloud URL for a clean inline slug prefix. */
export const formatWorkspaceSlugPrefix = (cloudUrl: string | undefined): string => {
  const host = cloudUrl ? cloudUrl.replace(/^https?:\/\//, '').replace(/\/$/, '') : ''
  return `${host}/w/`
}

export const workspaceFormSchema = z.object({
  name: z.string().refine((value) => value.trim().length > 0, { message: 'Workspace name is required' }),
  slug: z.string(),
  icon: z.string().nullable(),
})

export type WorkspaceFormValues = z.infer<typeof workspaceFormSchema>

type WorkspaceFormFieldsProps = {
  form: UseFormReturn<WorkspaceFormValues>
  /** Display string before the slug input — e.g. `cloud.example.com/w/`. */
  slugPrefix: string
  /** When false, the slug field is hidden entirely (used for Personal workspaces). */
  showSlug?: boolean
  /** First-letter fallback the icon picker shows when no icon is set. */
  iconPlaceholder?: string
  /**
   * Initial slug-lock state. Pass `true` when the workspace already carries a
   * custom slug so typing in name doesn't overwrite it. Default `false`.
   */
  initialSlugLocked?: boolean
  /** Fires on every keystroke into name/slug. Wire to a debounced save. */
  onDebouncedChange?: () => void
  /** Fires on name/slug blur and on icon select/remove. Wire to immediate save. */
  onCommit?: () => void
}

/**
 * Shared workspace form fields — name + slug (with URL prefix) + icon picker.
 * Owns the slug-derivation linkage between name and slug, the live slug
 * sanitisation, and the icon-picker integration. Save behaviour is up to the
 * caller — the settings page hooks autosave through `onDebouncedChange` /
 * `onCommit`; the create-workspace modal collects values via the form and
 * submits on button click without wiring either callback.
 */
export const WorkspaceFormFields = ({
  form,
  slugPrefix,
  showSlug = true,
  iconPlaceholder,
  initialSlugLocked = false,
  onDebouncedChange,
  onCommit,
}: WorkspaceFormFieldsProps) => {
  const [slugLocked, setSlugLocked] = useState(initialSlugLocked)

  return (
    <>
      <FormField
        control={form.control}
        name="name"
        render={({ field }) => (
          <FormItem>
            <FormLabel className="text-sm font-medium">Workspace name</FormLabel>
            <FormControl>
              <Input
                inputSize="lg"
                placeholder="e.g. Engineering"
                {...field}
                onChange={(e) => {
                  field.onChange(e)
                  if (!slugLocked && showSlug) {
                    form.setValue('slug', slugifyWorkspaceName(e.target.value), { shouldDirty: false })
                  }
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

      {showSlug && (
        <FormField
          control={form.control}
          name="slug"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="text-sm font-medium">Workspace URL</FormLabel>
              <div className="flex h-[var(--touch-height-lg)] w-full rounded-lg border border-input bg-transparent overflow-hidden focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-[3px]">
                <span className="flex items-center px-4 text-[length:var(--font-size-body)] text-muted-foreground bg-muted whitespace-nowrap select-none">
                  {slugPrefix}
                </span>
                <FormControl>
                  <input
                    type="text"
                    placeholder="engineering"
                    className="flex-1 min-w-0 px-4 py-2 bg-transparent outline-none text-[length:var(--font-size-body)]"
                    {...field}
                    onChange={(e) => {
                      const cleaned = sanitizeWorkspaceSlugInput(e.target.value)
                      field.onChange(cleaned)
                      setSlugLocked(true)
                      onDebouncedChange?.()
                    }}
                    onBlur={() => {
                      field.onBlur()
                      onCommit?.()
                    }}
                  />
                </FormControl>
              </div>
              <FormMessage />
            </FormItem>
          )}
        />
      )}

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
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </>
  )
}
