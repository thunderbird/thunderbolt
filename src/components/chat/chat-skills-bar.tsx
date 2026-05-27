/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Plus } from 'lucide-react'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useNavigate as useNavigate_default } from 'react-router'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useIsMobile } from '@/hooks/use-mobile'
import { ReorderPanel } from '@/skills/reorder-panel'
import { SuggestionChip } from '@/skills/suggestion-chip'
import { usePinnedSkills as usePinnedSkills_default } from '@/skills/use-skills'

type ChatSkillsBarProps = {
  /** Insert `"/slug "` into the chat input at the cursor. */
  onAddToChat: (slug: string) => void
  /** Insert the resolved skill's instruction prose into the chat input. */
  onAddInstruction: (instruction: string) => void
  // Dependency injection for tests / Storybook.
  usePinnedSkills?: typeof usePinnedSkills_default
  useNavigate?: typeof useNavigate_default
}

/**
 * Pinned-skills bar shown above the chat input: a horizontal scroll of
 * pinned chips plus a `+` shortcut to the skills settings page. The chip
 * dropdown triggers run / add / reorder / unpin; while a chip dropdown is
 * open on mobile the bar shows a backdrop so taps outside dismiss it.
 *
 * Returns `null` when the user has no pinned skills — the chat input
 * occupies the full vertical slot in that case.
 */
export const ChatSkillsBar = ({
  onAddToChat,
  onAddInstruction,
  usePinnedSkills = usePinnedSkills_default,
  useNavigate = useNavigate_default,
}: ChatSkillsBarProps) => {
  const { pinned, reorderPins, togglePin } = usePinnedSkills()
  const { isMobile } = useIsMobile()
  const navigate = useNavigate()

  const [openChipId, setOpenChipId] = useState<string | null>(null)
  const [reorderMode, setReorderMode] = useState(false)

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

  if (pinned.length === 0) {
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
            onRun={() => navigate('/', { state: { runSkill: skill.name } })}
            onAddInstruction={() => onAddInstruction(skill.instruction)}
            onReorder={() => setReorderMode(true)}
            onUnpin={() => togglePin(skill.id)}
          />
        ))}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              asChild
              variant="outline"
              size="icon-sm"
              aria-label="Manage skills"
              className={`size-8 shrink-0 cursor-pointer rounded-full bg-card transition-opacity ${
                openChipId ? 'opacity-40' : ''
              }`}
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
