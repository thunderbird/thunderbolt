/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { maxPinnedSkills } from '@/dal'
import { useIsMobile } from '@/hooks/use-mobile'
import { ReorderPanel } from '@/skills/reorder-panel'
import { SuggestionChip } from '@/skills/suggestion-chip'
import { useSkillTelemetry } from '@/skills/telemetry'
import {
  useEnabledSkills as useEnabledSkills_default,
  useLibrarySkills as useLibrarySkills_default,
  usePinnedSkills as usePinnedSkills_default,
} from '@/skills/use-skills'

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

  const [reorderMode, setReorderMode] = useState(false)
  const [addOpen, setAddOpen] = useState(false)

  if (hidden) {
    return null
  }

  if (reorderMode) {
    return (
      <>
        {isMobile && <MobileOverlay onDismiss={() => setReorderMode(false)} />}
        <ReorderPanel
          pinned={pinned}
          onReorder={async (ids, move) => {
            // `move` comes from dnd-kit's `active.id` / index lookup — unambiguous
            // even for adjacent swaps, where a diff-based heuristic can't tell
            // which side the user actually dragged. Await the mutation before
            // firing telemetry so a rejection doesn't record a phantom event.
            try {
              await reorderPins(ids)
              trackSkillEvent('skill_reordered', move.id, { from_index: move.from, to_index: move.to })
            } catch (error) {
              console.warn('reorderPins failed:', error)
            }
          }}
          onClose={() => setReorderMode(false)}
        />
      </>
    )
  }

  // Pinnable = enabled and not already pinned. The popover only ever lists
  // pin candidates, never a dual "pin / unpin" surface — unpin lives on the
  // chip's own dropdown.
  const pinnable = library.filter((s) => isEnabled(s.id) && !pinnedSet.has(s.id))
  const pinCapReached = pinnedSet.size >= maxPinnedSkills
  // The trigger stays clickable even with nothing left to pin — the popover
  // still offers "New Skill". Only the pin cap blocks it: the DAL throws
  // PinLimitExceededError on the 11th pin and the catch below would swallow
  // it silently, so that case is blocked upstream with explicit copy.
  const addDisabled = pinCapReached

  // Hide the whole bar only when there's nothing to display *and* nothing
  // to add. If the user has zero pins but unpinned skills exist, we still
  // show the `+` button so they can pin one.
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
        // `hover:bg-accent/50` matches the SuggestionChip hover — full accent
        // is too dark a step in light mode; dark mode keeps the outline
        // variant's `dark:hover:bg-input/50`.
        className="shrink-0 cursor-pointer rounded-full border-none bg-sidebar shadow-[0_0_16px_rgba(38,33,32,0.06)] hover:bg-accent/50 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-sidebar"
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
            label={skill.name}
            onClick={() => onAddToChat(skill.name)}
            onAddInstruction={() => onAddInstruction(skill.instruction)}
            onReorder={() => setReorderMode(true)}
            onUnpin={async () => {
              // Telemetry only fires after the mutation settles, so a rejection
              // doesn't record an action the user didn't actually complete.
              try {
                await togglePin(skill.id)
                trackSkillEvent('skill_unpinned', skill.id, {})
              } catch (error) {
                console.warn('togglePin failed:', error)
              }
            }}
          />
        ))}
        <Popover open={addOpen} onOpenChange={setAddOpen}>
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
            <ul className="max-h-64 overflow-y-auto">
              {pinnable.length === 0 && (
                <li className="px-2 py-1.5 text-[length:var(--font-size-sm)] text-muted-foreground">
                  All skills are pinned
                </li>
              )}
              {pinnable.map((skill) => (
                <li key={skill.id}>
                  <button
                    type="button"
                    onClick={async () => {
                      // Close the popover synchronously so it doesn't sit open
                      // while the mutation lands. Telemetry fires after the
                      // mutation settles so we never report a phantom pin if
                      // togglePin races past the cap guard.
                      setAddOpen(false)
                      try {
                        await togglePin(skill.id)
                        trackSkillEvent('skill_pinned', skill.id, {})
                      } catch (error) {
                        console.warn('togglePin failed:', error)
                      }
                    }}
                    // `rounded-lg` so the hover highlight sits concentrically
                    // inside the `rounded-xl` container's `p-1` padding — outer
                    // radius minus 4px padding. Matches the slash autocomplete
                    // popover.
                    className="flex w-full cursor-pointer flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent"
                  >
                    <span className="truncate text-[length:var(--font-size-body)] text-foreground">/{skill.name}</span>
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
                Skill" row that jumps to the create form in settings. */}
            <div className="-mx-1 mt-1 border-t border-border px-1 pt-1">
              <button
                type="button"
                onClick={() => {
                  setAddOpen(false)
                  void navigate('/settings/skills', { state: { createSkill: '' } })
                }}
                className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[length:var(--font-size-body)] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <Plus className="size-4" />
                New Skill
              </button>
            </div>
          </PopoverContent>
        </Popover>
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
