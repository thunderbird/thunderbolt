/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Lock, Users } from 'lucide-react'

import { Label } from '@/components/ui/label'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

export type ResourceScope = 'workspace' | 'user'

export type ScopePickerProps = {
  /** Currently-selected scope. */
  value: ResourceScope
  /** Fires with the next scope on user interaction. */
  onChange: (next: ResourceScope) => void
  /**
   * Optional id used to associate the visible label with the toggle group for
   * screen readers. The toggle group itself can't accept `id` because Radix
   * forwards it to an inner element, so we anchor the htmlFor on the label
   * and rely on `aria-describedby` for the hint text.
   */
  id?: string
  /** Optional override label. Defaults to "Visibility". */
  label?: string
  /** Disables the picker — used when the form is mid-submit. */
  disabled?: boolean
  /**
   * Render the picker as a non-interactive display of the current value (e.g.
   * the skill detail page). Distinct from `disabled` — `readOnly` keeps the
   * normal selected-state styling (no opacity dimming) and silences clicks,
   * which is the right look for "this is what's set" rather than "you can't
   * change this right now."
   */
  readOnly?: boolean
}

/**
 * Per-row visibility picker for the 8 workspace-shared resource tables
 * (THU-603). Two states:
 *
 * - `workspace` — shared with every workspace member (the historical default).
 * - `user` — private to the row's author within the workspace; other members
 *   never see the row.
 *
 * Callers are responsible for gating mount on `selectAllowUserScopedResources`
 * (deployment flag) and on the active workspace being shared (the choice is
 * meaningless in a personal workspace where the only member IS the user).
 */
export const ScopePicker = ({ value, onChange, id, label = 'Visibility', disabled, readOnly }: ScopePickerProps) => {
  const hintId = id ? `${id}-hint` : undefined
  const hint = value === 'user' ? 'Only you can see this in the workspace.' : 'Shared with everyone in the workspace.'

  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <ToggleGroup
        id={id}
        type="single"
        variant="outline"
        size="default"
        value={value}
        onValueChange={(next) => {
          if (readOnly) {
            return
          }
          // Radix emits an empty string when the user clicks the already-active
          // item; the picker is a required choice, so ignore the deselect.
          if (next === 'workspace' || next === 'user') {
            onChange(next)
          }
        }}
        aria-describedby={hintId}
        aria-readonly={readOnly || undefined}
        disabled={disabled}
        // `pointer-events-none` blocks the click without applying the
        // disabled-state opacity dim — read-only should look "informational",
        // not "unavailable."
        className={readOnly ? 'pointer-events-none' : undefined}
      >
        {/* Items override the group's default `flex-1` so each option sizes to
            its content with comfortable horizontal padding — keeps "Workspace"
            from looking cramped against the icon. */}
        <ToggleGroupItem
          value="workspace"
          aria-label="Shared with the workspace"
          className="flex-none px-3"
          tabIndex={readOnly ? -1 : undefined}
        >
          <Users className="mr-2 h-4 w-4" />
          Workspace
        </ToggleGroupItem>
        <ToggleGroupItem
          value="user"
          aria-label="Private to you"
          className="flex-none px-3"
          tabIndex={readOnly ? -1 : undefined}
        >
          <Lock className="mr-2 h-4 w-4" />
          Private
        </ToggleGroupItem>
      </ToggleGroup>
      <p id={hintId} className="text-[length:var(--font-size-xs)] text-muted-foreground">
        {hint}
      </p>
    </div>
  )
}
