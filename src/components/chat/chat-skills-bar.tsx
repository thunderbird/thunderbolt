/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Plus } from 'lucide-react'
import { useEffect, useReducer } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SearchInput } from '@/components/ui/search-input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { maxPinnedSkills } from '@/dal'
import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/utils'
import { skillDisplayName, skillMatchesQuery } from '@/skills/display'
import { ReorderPanel } from '@/skills/reorder-panel'
import { chipSurfaceClass, SuggestionChip } from '@/skills/suggestion-chip'
import { useSkillTelemetry } from '@/skills/telemetry'
import {
  useEnabledSkills as useEnabledSkills_default,
  useLibrarySkills as useLibrarySkills_default,
  usePinnedSkills as usePinnedSkills_default,
} from '@/skills/use-skills'
import type { Skill } from '@/types'

type BarState = {
  reorderMode: boolean
  addOpen: boolean
  addQuery: string
  /** Last pin/unpin/reorder failure, shown inline; cleared on the next action. */
  actionError: string | null
}

type BarAction =
  | { type: 'REORDER_OPENED' }
  | { type: 'REORDER_CLOSED' }
  | { type: 'ADD_POPOVER_TOGGLED'; open: boolean }
  | { type: 'ADD_QUERY_CHANGED'; value: string }
  | { type: 'MUTATION_STARTED' }
  | { type: 'MUTATION_FAILED'; message: string }

const initialBarState: BarState = { reorderMode: false, addOpen: false, addQuery: '', actionError: null }

const barReducer = (state: BarState, action: BarAction): BarState => {
  switch (action.type) {
    case 'REORDER_OPENED':
      return { ...state, reorderMode: true }
    case 'REORDER_CLOSED':
      return { ...state, reorderMode: false }
    case 'ADD_POPOVER_TOGGLED':
      // Closing resets the search so a reopen starts from the full list.
      return action.open ? { ...state, addOpen: true } : { ...state, addOpen: false, addQuery: '' }
    case 'ADD_QUERY_CHANGED':
      return { ...state, addQuery: action.value }
    case 'MUTATION_STARTED':
      return { ...state, actionError: null }
    case 'MUTATION_FAILED':
      return { ...state, actionError: action.message }
  }
}

type ChatSkillsBarProps = {
  /** Insert `"/slug "` into the chat input at the cursor. */
  onAddToChat: (slug: string) => void
  /** Insert the resolved skill's instruction prose into the chat input. */
  onAddInstruction: (instruction: string) => void
  /**
   * When `true`, render nothing. The composer toggles this on once any
   * message has been sent so the chips don't compete for space in an
   * ongoing thread — pinning is a "starting a new chat" affordance.
   */
  hidden?: boolean
  // Dependency injection for tests / Storybook.
  usePinnedSkills?: typeof usePinnedSkills_default
  useLibrarySkills?: typeof useLibrarySkills_default
  useEnabledSkills?: typeof useEnabledSkills_default
}

/**
 * Pinned-skills bar shown above the chat input: a horizontal scroll of
 * pinned chips plus a `+` button that opens a popover listing enabled
 * skills the user hasn't pinned yet — clicking one pins it on the spot
 * (no navigation). This is the canonical "add a pinned skill" entry point;
 * the `/settings/skills` route doesn't expose pin controls.
 *
 * Returns `null` when the user has no pinned skills *and* the popover is
 * closed — once they pin one the bar reappears.
 */
export const ChatSkillsBar = ({
  onAddToChat,
  onAddInstruction,
  hidden,
  usePinnedSkills = usePinnedSkills_default,
  useLibrarySkills = useLibrarySkills_default,
  useEnabledSkills = useEnabledSkills_default,
}: ChatSkillsBarProps) => {
  const { pinned, pinnedSet, reorderPins, togglePin } = usePinnedSkills()
  const { skills: library } = useLibrarySkills()
  const { isEnabled } = useEnabledSkills()
  const { isMobile } = useIsMobile()
  const trackSkillEvent = useSkillTelemetry()
  const navigate = useNavigate()

  const [{ reorderMode, addOpen, addQuery, actionError }, dispatch] = useReducer(barReducer, initialBarState)

  // One shared pin/unpin path: telemetry only fires after the mutation
  // settles (so a rejection never records a phantom action), and a failure
  // surfaces inline instead of vanishing into the console alone.
  const handleTogglePin = async (skill: Skill, action: 'pin' | 'unpin') => {
    dispatch({ type: 'MUTATION_STARTED' })
    try {
      await togglePin(skill.id)
      trackSkillEvent(action === 'pin' ? 'skill_pinned' : 'skill_unpinned', skill.id, {})
    } catch (error) {
      console.error('togglePin failed:', error)
      dispatch({
        type: 'MUTATION_FAILED',
        message:
          action === 'pin' ? `Couldn't pin ${skillDisplayName(skill)}.` : `Couldn't unpin ${skillDisplayName(skill)}.`,
      })
    }
  }

  if (hidden) {
    return null
  }

  if (reorderMode) {
    return (
      <>
        {isMobile && <MobileOverlay onDismiss={() => dispatch({ type: 'REORDER_CLOSED' })} />}
        <ReorderPanel
          pinned={pinned}
          onReorder={async (ids, move) => {
            // `move` comes from dnd-kit's `active.id` / index lookup — unambiguous
            // even for adjacent swaps, where a diff-based heuristic can't tell
            // which side the user actually dragged. Await the mutation before
            // firing telemetry so a rejection doesn't record a phantom event.
            dispatch({ type: 'MUTATION_STARTED' })
            try {
              await reorderPins(ids)
              trackSkillEvent('skill_reordered', move.id, { from_index: move.from, to_index: move.to })
            } catch (error) {
              console.error('reorderPins failed:', error)
              dispatch({ type: 'MUTATION_FAILED', message: "Couldn't save the new order." })
            }
          }}
          onClose={() => dispatch({ type: 'REORDER_CLOSED' })}
        />
      </>
    )
  }

  // Pinnable = enabled and not already pinned. The popover only ever lists
  // pin candidates, never a dual "pin / unpin" surface — unpin lives on the
  // chip's own dropdown.
  const pinnable = library.filter((s) => isEnabled(s.id) && !pinnedSet.has(s.id))
  const query = addQuery.trim()
  const pinnableFiltered = pinnable.filter((s) => skillMatchesQuery(s, query))
  const pinCapReached = pinnedSet.size >= maxPinnedSkills
  // While the bar renders, the trigger stays clickable even with nothing left
  // to pin — the popover still offers "New skill". Only the pin cap blocks it:
  // the DAL throws PinLimitExceededError on the 11th pin and the catch below
  // would swallow it silently, so that case is blocked upstream with explicit
  // copy.
  const addDisabled = pinCapReached

  // Hide the whole bar only when there's nothing to display *and* nothing to
  // pin (empty library or every skill disabled) — brand-new users get the
  // create CTA on /settings/skills instead of a lone `+` here. If the user
  // has zero pins but unpinned skills exist, the `+` button still shows.
  if (pinned.length === 0 && pinnable.length === 0) {
    return null
  }

  const addButton = (
    <PopoverTrigger asChild>
      <Button
        variant="outline"
        size="icon-sm"
        aria-label="Add a skill"
        disabled={addDisabled}
        className={cn(chipSurfaceClass, 'disabled:cursor-not-allowed disabled:opacity-40')}
      >
        <Plus />
      </Button>
    </PopoverTrigger>
  )

  return (
    <>
      {/* Generous padding (cancelled by matching negative margins) keeps the
          chips' soft glow shadow from being clipped by the scroll container —
          overflow-x-auto forces vertical clipping too. */}
      <div className="-mx-4 -my-4 flex items-center gap-2 overflow-x-auto px-4 py-4 [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
        {pinned.map((skill) => (
          <SuggestionChip
            key={skill.id}
            label={skillDisplayName(skill)}
            onClick={() => onAddToChat(skill.name)}
            onAddInstruction={() => onAddInstruction(skill.instruction)}
            onEdit={() => void navigate('/settings/skills', { state: { startEditSkill: skill.id } })}
            onReorder={() => dispatch({ type: 'REORDER_OPENED' })}
            onUnpin={() => handleTogglePin(skill, 'unpin')}
          />
        ))}
        <Popover open={addOpen} onOpenChange={(open) => dispatch({ type: 'ADD_POPOVER_TOGGLED', open })}>
          {/* Tooltip only in the disabled pin-cap state — it explains why the
              button doesn't work. The enabled `+` needs no hover copy. */}
          {pinCapReached ? (
            <Tooltip>
              <TooltipTrigger asChild>{addButton}</TooltipTrigger>
              <TooltipContent>{`Pin limit reached (${maxPinnedSkills}). Unpin one first.`}</TooltipContent>
            </Tooltip>
          ) : (
            addButton
          )}
          {/*
            `collisionPadding={12}` keeps the popover 12px off the viewport
            edges. On mobile the content is sized to `calc(100vw-1.5rem)` (24px
            narrower than the viewport), so collision avoidance pins it to a
            12px-both-sides margin — i.e. exactly as wide as the chat composer
            (px-3 insets) and centered on it, mirroring the chip dropdown. On
            desktop the fixed `w-72` leaves room, so the padding never shifts
            the `align="start"` anchor off the `+` button.
          */}
          <PopoverContent
            side="top"
            align="start"
            sideOffset={8}
            collisionPadding={12}
            className={isMobile ? 'w-[calc(100vw-1.5rem)] p-1' : 'w-72 max-w-[calc(100vw-1.5rem)] p-1'}
          >
            {/* Search only appears once the list is long enough for scanning
                to hurt (6+ rows) — a filter box above a short list is noise. */}
            {pinnable.length > 5 && (
              <div className="p-1 pb-2">
                <SearchInput
                  value={addQuery}
                  onChange={(e) => dispatch({ type: 'ADD_QUERY_CHANGED', value: e.target.value })}
                  inputSize="sm"
                  placeholder="Search skills"
                  aria-label="Search skills"
                  autoFocus={!isMobile}
                />
              </div>
            )}
            <ul className="max-h-64 overflow-y-auto">
              {pinnable.length === 0 && (
                <li className="px-2 py-1.5 text-[length:var(--font-size-sm)] text-muted-foreground">
                  All skills are pinned
                </li>
              )}
              {pinnable.length > 0 && pinnableFiltered.length === 0 && (
                <li className="px-2 py-1.5 text-[length:var(--font-size-sm)] text-muted-foreground">
                  No matching skills
                </li>
              )}
              {pinnableFiltered.map((skill) => (
                <li key={skill.id}>
                  <button
                    type="button"
                    onClick={() => {
                      // Close the popover synchronously so it doesn't sit open
                      // while the mutation lands. A failure (e.g. a pin-cap
                      // race past the guard) surfaces via `actionError`.
                      dispatch({ type: 'ADD_POPOVER_TOGGLED', open: false })
                      void handleTogglePin(skill, 'pin')
                    }}
                    // `rounded-lg` so the hover highlight sits concentrically
                    // inside the `rounded-xl` container's `p-1` padding — outer
                    // radius minus 4px padding. Matches the slash autocomplete
                    // popover.
                    className="flex w-full cursor-pointer flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent"
                  >
                    <span className="truncate text-[length:var(--font-size-body)] text-foreground">
                      {skillDisplayName(skill)}
                    </span>
                    {skill.description && (
                      <span className="line-clamp-1 text-[length:var(--font-size-sm)] text-muted-foreground">
                        {skill.description}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
            {/* Fixed footer below the scrollable list: full-bleed divider
                (negative margins cancel the container's p-1) with a "New
                skill" row that jumps to the create form in settings. */}
            <div className="-mx-1 mt-1 border-t border-border px-1 pt-1">
              <button
                type="button"
                onClick={() => {
                  dispatch({ type: 'ADD_POPOVER_TOGGLED', open: false })
                  void navigate('/settings/skills', { state: { createSkill: '' } })
                }}
                className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[length:var(--font-size-body)] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <Plus className="size-4" />
                New skill
              </button>
            </div>
          </PopoverContent>
        </Popover>
        {actionError && (
          <p role="alert" className="shrink-0 text-[length:var(--font-size-sm)] text-destructive">
            {actionError}
          </p>
        )}
      </div>
    </>
  )
}

/**
 * Backdrop shown behind the reorder panel on mobile.
 * A `<button>` rather than a `<div>` so keyboard users can `Escape` /
 * `Enter` / `Space` to dismiss; the document-level Escape listener is the
 * primary path, but the button keeps the dismiss target focusable for
 * screen readers and assistive tech.
 */
const MobileOverlay = ({ onDismiss }: { onDismiss: () => void }) => {
  // Document-level Escape so users don't have to focus the backdrop first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onDismiss()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onDismiss])

  return createPortal(
    <button
      type="button"
      aria-label="Dismiss"
      className="fixed inset-0 z-[5] cursor-default bg-black/30 backdrop-blur-sm"
      onClick={onDismiss}
    />,
    document.body,
  )
}
