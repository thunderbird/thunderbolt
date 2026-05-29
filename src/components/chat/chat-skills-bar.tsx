/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useIsMobile } from '@/hooks/use-mobile'
import { ReorderPanel } from '@/skills/reorder-panel'
import { SuggestionChip } from '@/skills/suggestion-chip'
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

  const [openChipId, setOpenChipId] = useState<string | null>(null)
  const [reorderMode, setReorderMode] = useState(false)
  const [addOpen, setAddOpen] = useState(false)

  if (hidden) {
    return null
  }

  const showOverlay = isMobile && (openChipId !== null || reorderMode)
  const dismissOverlay = () => {
    setOpenChipId(null)
    setReorderMode(false)
  }

  if (reorderMode) {
    return (
      <>
        {showOverlay && <MobileOverlay onDismiss={dismissOverlay} />}
        <ReorderPanel pinned={pinned} onReorder={reorderPins} onClose={() => setReorderMode(false)} />
      </>
    )
  }

  // Pinnable = enabled and not already pinned. The popover only ever lists
  // pin candidates, never a dual "pin / unpin" surface — unpin lives on the
  // chip's own dropdown.
  const pinnable = library.filter((s) => isEnabled(s.id) && !pinnedSet.has(s.id))

  // Hide the whole bar only when there's nothing to display *and* nothing
  // to add. If the user has zero pins but unpinned skills exist, we still
  // show the `+` button so they can pin one.
  if (pinned.length === 0 && pinnable.length === 0) {
    return null
  }

  return (
    <>
      {showOverlay && <MobileOverlay onDismiss={dismissOverlay} />}
      <div className="-mx-1 flex items-center gap-2 overflow-x-auto px-1 [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
        {pinned.map((skill) => (
          <SuggestionChip
            key={skill.id}
            label={skill.name}
            dimmed={openChipId !== null && openChipId !== skill.id}
            onClick={() => onAddToChat(skill.name)}
            onOpenChange={(open) => setOpenChipId(open ? skill.id : null)}
            onAddInstruction={() => onAddInstruction(skill.instruction)}
            onReorder={() => setReorderMode(true)}
            onUnpin={() => togglePin(skill.id)}
          />
        ))}
        <Popover open={addOpen} onOpenChange={setAddOpen}>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label="Pin a skill"
                  disabled={pinnable.length === 0}
                  className={`shrink-0 cursor-pointer rounded-full bg-card transition-opacity disabled:cursor-not-allowed disabled:opacity-40 ${
                    openChipId ? 'opacity-40' : ''
                  }`}
                >
                  <Plus />
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent>{pinnable.length === 0 ? 'No more skills to pin' : 'Pin a skill'}</TooltipContent>
          </Tooltip>
          <PopoverContent side="top" align="start" sideOffset={6} className="w-72 max-w-[calc(100vw-2rem)] p-1">
            <ul className="max-h-64 overflow-y-auto">
              {pinnable.map((skill) => (
                <li key={skill.id}>
                  <button
                    type="button"
                    onClick={() => {
                      void togglePin(skill.id).catch((error) => console.warn('togglePin failed:', error))
                      setAddOpen(false)
                    }}
                    className="flex w-full cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent"
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
          </PopoverContent>
        </Popover>
      </div>
    </>
  )
}

/**
 * Backdrop shown behind an open chip menu / the reorder panel on mobile.
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
