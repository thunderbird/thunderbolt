/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Plus } from 'lucide-react'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useIsMobile } from '@/hooks/use-mobile'
import { ReorderPanel } from '@/skills/reorder-panel'
import { SuggestionChip } from '@/skills/suggestion-chip'
import { useLibrarySkills, usePinnedSkills } from '@/skills/use-skills-placeholder'

type ChatSkillsBarProps = {
  /** Insert `"<skill-name> "` into the chat input at the cursor. */
  onAddToChat: (skillName: string) => void
  /** Insert the skill's instruction prose into the chat input at the cursor. */
  onAddInstruction: (instructionText: string) => void
}

/**
 * Skills row shown above the prompt input: pinned-skill chips, a reorder
 * panel, and a shortcut to the skills settings page.
 *
 * Data and mutations are read from `use-skills-placeholder.ts` — replace
 * that module's hooks with real backend-backed implementations to wire
 * this UI up. No other changes to this component should be necessary.
 */
export const ChatSkillsBar = ({ onAddToChat, onAddInstruction }: ChatSkillsBarProps) => {
  const { pinned, movePinned, togglePin } = usePinnedSkills()
  const { skills: library } = useLibrarySkills()
  const { isMobile } = useIsMobile()

  const [openChip, setOpenChip] = useState<string | null>(null)
  const [reorderMode, setReorderMode] = useState(false)

  const showOverlay = isMobile && (openChip !== null || reorderMode)
  const dismissOverlay = () => {
    setOpenChip(null)
    setReorderMode(false)
  }

  if (reorderMode) {
    return (
      <>
        {showOverlay && <MobileOverlay onDismiss={dismissOverlay} />}
        <ReorderPanel skills={pinned} onMove={movePinned} onClose={() => setReorderMode(false)} />
      </>
    )
  }

  if (pinned.length === 0) {
    return null
  }

  return (
    <>
      {showOverlay && <MobileOverlay onDismiss={dismissOverlay} />}
      <div className="-mx-1 flex items-center gap-2 overflow-x-auto px-1 [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
        {pinned.map((name) => {
          const skill = library.find((s) => s.name === name)
          return (
            <SuggestionChip
              key={name}
              label={name}
              dimmed={openChip !== null && openChip !== name}
              onClick={() => onAddToChat(name)}
              onOpenChange={(open) => setOpenChip(open ? name : null)}
              runHref={`/?run=${encodeURIComponent(name)}`}
              onAddInstruction={() => onAddInstruction(skill?.instruction ?? name)}
              onReorder={() => setReorderMode(true)}
              onUnpin={() => togglePin(name)}
            />
          )
        })}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              asChild
              variant="outline"
              size="icon-sm"
              aria-label="Manage skills"
              className={`size-8 shrink-0 rounded-full bg-card transition-opacity ${openChip ? 'opacity-40' : ''}`}
            >
              <Link to="/settings/skills">
                <Plus />
              </Link>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Pin skills for quick access</TooltipContent>
        </Tooltip>
      </div>
    </>
  )
}

const MobileOverlay = ({ onDismiss }: { onDismiss: () => void }) =>
  createPortal(
    <div className="fixed inset-0 z-[5] bg-black/30 backdrop-blur-sm" aria-hidden="true" onClick={onDismiss} />,
    document.body,
  )
