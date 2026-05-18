/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Info } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { renderHighlightedSkillTokens } from './highlight-skill-tokens'
import { SlashPopup } from './slash-popup'
import { useSlashCommand } from './use-slash-command'
import type { Skill } from './skills-data'

export type SkillFormMode = 'create' | 'edit'

// Overlay styling must mirror the shadcn Textarea's content box exactly so the
// highlighted text aligns with what the user types.
const overlayClass =
  'pointer-events-none absolute inset-0 z-10 overflow-hidden whitespace-pre-wrap break-words rounded-xl border border-transparent px-2.5 py-2 text-base text-foreground'

export const SkillForm = ({
  onCancel,
  onSubmit,
  onDirtyChange,
  resetSignal,
  mode = 'create',
  initialValues,
  isValidSkillRef,
  library,
  isEnabled,
  recent,
  onRecordSkillUsed,
}: {
  onCancel: () => void
  onSubmit?: (values: { name: string; description: string; instruction: string }) => void
  onDirtyChange?: (dirty: boolean) => void
  resetSignal?: number
  mode?: SkillFormMode
  initialValues?: { name: string; description: string; instruction: string }
  isValidSkillRef?: (token: string) => boolean
  library?: Skill[]
  isEnabled?: (name: string) => boolean
  recent?: string[]
  onRecordSkillUsed?: (name: string) => void
}) => {
  const initialName = initialValues?.name ?? ''
  const initialDescription = initialValues?.description ?? ''
  const initialInstruction = initialValues?.instruction ?? ''

  const [name, setName] = useState(initialName)
  const [description, setDescription] = useState(initialDescription)
  const [instruction, setInstruction] = useState(initialInstruction)
  const descOverlayRef = useRef<HTMLDivElement>(null)
  const instOverlayRef = useRef<HTMLDivElement>(null)
  const instructionRef = useRef<HTMLTextAreaElement>(null)
  const matchSkillRef = isValidSkillRef ?? (() => false)

  const slashEnabled =
    library !== undefined && isEnabled !== undefined && recent !== undefined && onRecordSkillUsed !== undefined
  const slash = useSlashCommand({
    value: instruction,
    setValue: setInstruction,
    inputRef: instructionRef,
    library: library ?? [],
    isEnabled: isEnabled ?? (() => false),
    recent: recent ?? [],
    recordUsed: onRecordSkillUsed ?? (() => {}),
  })

  const canSubmit = name.trim() !== '' && description.trim() !== '' && instruction.trim() !== ''

  const isDirty =
    mode === 'edit'
      ? name !== initialName || description !== initialDescription || instruction !== initialInstruction
      : name.length > 0 || description.length > 0 || instruction.length > 0

  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  const [prevResetSignal, setPrevResetSignal] = useState(resetSignal)
  if (resetSignal !== undefined && prevResetSignal !== resetSignal) {
    setPrevResetSignal(resetSignal)
    setName(initialName)
    setDescription(initialDescription)
    setInstruction(initialInstruction)
  }

  return (
    <section className="flex h-full flex-1 flex-col bg-background text-foreground">
      <div className="flex min-h-0 flex-1 flex-col gap-5 px-6 py-5">
        <h2 className="text-xl text-foreground">{mode === 'edit' ? 'Edit Skill' : 'Create Skill'}</h2>

        <div className="flex flex-col gap-2">
          <label htmlFor="skill-name" className="text-base text-foreground">
            Skill name
          </label>
          <Input
            id="skill-name"
            placeholder="meeting-notes"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-9"
          />
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="skill-description" className="flex items-center gap-1.5 text-base text-foreground">
            Description
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="What is this for?"
                  className="text-muted-foreground hover:text-foreground"
                >
                  <Info size={14} strokeWidth={1.75} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" className="max-w-[202px]">
                Helps the agent decide when to use this skill. Be specific about when it applies.
              </TooltipContent>
            </Tooltip>
          </label>
          <div className="relative">
            <div ref={descOverlayRef} aria-hidden="true" className={overlayClass}>
              {renderHighlightedSkillTokens(description, matchSkillRef)}
            </div>
            <Textarea
              id="skill-description"
              rows={3}
              placeholder="Use when the user shares raw meeting notes or a transcript and wants it cleaned up, summarized, or turned into action items."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onScroll={(e) => {
                if (descOverlayRef.current) {
                  descOverlayRef.current.scrollTop = e.currentTarget.scrollTop
                }
              }}
              className="text-transparent caret-foreground"
            />
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <label htmlFor="skill-instruction" className="text-base text-foreground">
            Instructions
          </label>
          <div className="relative min-h-0 flex-1">
            {slashEnabled && slash.popupOpen && (
              <SlashPopup
                skills={slash.popupSkills}
                highlightedIdx={slash.highlightedIdx}
                onSelect={slash.selectSkill}
                onHover={slash.setHighlightedIdx}
              />
            )}
            <div ref={instOverlayRef} aria-hidden="true" className={overlayClass}>
              {renderHighlightedSkillTokens(instruction, matchSkillRef)}
            </div>
            <Textarea
              ref={instructionRef}
              id="skill-instruction"
              placeholder={`Pull out three things from the notes: decisions made, action items (who does what by when), and open questions.\n\nDon't add a summary paragraph – just the lists. Then ask if they want help sending it to anyone.`}
              value={instruction}
              onChange={(e) => {
                setInstruction(e.target.value)
                slash.setCursorPos(e.target.selectionStart)
              }}
              onSelect={(e) => slash.setCursorPos(e.currentTarget.selectionStart)}
              onKeyDown={slash.handleKeyDown}
              onScroll={(e) => {
                if (instOverlayRef.current) {
                  instOverlayRef.current.scrollTop = e.currentTarget.scrollTop
                }
              }}
              className="absolute inset-0 h-full w-full resize-none text-transparent caret-foreground"
            />
          </div>
        </div>
      </div>

      <footer className="flex items-center justify-end gap-2 px-6 py-4">
        <Button variant="outline" size="lg" onClick={onCancel} className="text-sm">
          Cancel
        </Button>
        <Button
          variant="default"
          size="lg"
          disabled={!canSubmit}
          className="text-sm"
          onClick={() => {
            if (!canSubmit) {
              return
            }
            const trimmedName = name.trim()
            const finalName = trimmedName.startsWith('/') ? trimmedName : `/${trimmedName}`
            onSubmit?.({
              name: finalName,
              description: description.trim(),
              instruction: instruction.trim(),
            })
          }}
        >
          {mode === 'edit' ? 'Save' : 'Create'}
        </Button>
      </footer>
    </section>
  )
}
