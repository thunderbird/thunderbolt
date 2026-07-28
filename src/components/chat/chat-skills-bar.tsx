/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Plus } from 'lucide-react'
import { lazy, Suspense, useReducer } from 'react'
import { flushSync } from 'react-dom'

import { useCreateItem } from '@/components/create-item/context'
import { Button } from '@/components/ui/button'
import { MobileCardMenu } from '@/components/ui/mobile-card-menu'
import { ResponsivePopover } from '@/components/ui/responsive-popover'
import { SearchInput } from '@/components/ui/search-input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { maxPinnedSkills } from '@/dal'
import { isWidgetSkillId } from '@/defaults/skills'
import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/utils'
import { skillDisplayName, skillMatchesQuery } from '@/skills/display'
import { chipSurfaceClass, SuggestionChip } from '@/skills/suggestion-chip'
import { useSkillTelemetry } from '@/skills/telemetry'
import {
  useEnabledSkills as useEnabledSkills_default,
  useLibrarySkills as useLibrarySkills_default,
  usePinnedSkills as usePinnedSkills_default,
} from '@/skills/use-skills'
import type { Skill } from '@/types'

const loadReorderPanel = () => import('@/skills/reorder-panel')
const ReorderPanel = lazy(() => loadReorderPanel().then((module) => ({ default: module.ReorderPanel })))

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
  /** Insert the skill's display token into the chat input at the cursor. */
  onAddToChat: (skill: Skill) => void
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
  const { openCreateItem } = useCreateItem()

  const [{ reorderMode, addOpen, addQuery, actionError }, dispatch] = useReducer(barReducer, initialBarState)
  const lockedPinnedIds = new Set(pinned.filter((skill) => isWidgetSkillId(skill.id)).map((skill) => skill.id))

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

  const closeReorder = () => dispatch({ type: 'REORDER_CLOSED' })
  const reorderPanel = (
    <Suspense fallback={null}>
      <ReorderPanel
        pinned={pinned}
        lockedIds={lockedPinnedIds}
        embedded={isMobile}
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
        onClose={closeReorder}
      />
    </Suspense>
  )

  if (reorderMode && !isMobile) {
    return reorderPanel
  }

  // Pinnable = enabled and not already pinned. The popover only ever lists
  // pin candidates, never a dual "pin / unpin" surface — unpin lives on the
  // chip's own dropdown.
  const pinnable = library.filter((s) => !isWidgetSkillId(s.id) && isEnabled(s.id) && !pinnedSet.has(s.id))
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

  const setAddOpen = (open: boolean) => dispatch({ type: 'ADD_POPOVER_TOGGLED', open })

  const addButton = (
    <Button
      variant="outline"
      size="icon-sm"
      aria-label="Add a skill"
      disabled={addDisabled}
      className={cn(chipSurfaceClass, 'disabled:cursor-not-allowed disabled:opacity-40')}
    >
      <Plus className="size-[var(--icon-size-default)]" />
    </Button>
  )

  const addMenuContent = (
    <>
      {/* Search only appears once the list is long enough for scanning to
          hurt (6+ rows) — a filter box above a short list is noise. */}
      {pinnable.length > 5 && (
        <div className="shrink-0 p-1 pb-2">
          <SearchInput
            value={addQuery}
            onChange={(event) => dispatch({ type: 'ADD_QUERY_CHANGED', value: event.target.value })}
            placeholder="Search skills"
            aria-label="Search skills"
            autoFocus={!isMobile}
          />
        </div>
      )}
      {/* The list is the only region that scrolls: on desktop it caps at
          16rem; on mobile the drawer (shrunk by the keyboard inset) bounds it,
          keeping the search field and "New Skill" row pinned and visible. */}
      <ul className="min-h-0 overflow-y-auto overscroll-contain md:max-h-64">
        {pinnable.length === 0 && (
          <li className="px-2 py-1.5 text-[length:var(--font-size-sm)] text-muted-foreground">All skills are pinned</li>
        )}
        {pinnable.length > 0 && pinnableFiltered.length === 0 && (
          <li className="px-2 py-1.5 text-[length:var(--font-size-sm)] text-muted-foreground">No matching skills</li>
        )}
        {pinnableFiltered.map((skill) => (
          <li key={skill.id}>
            <button
              type="button"
              onClick={() => {
                setAddOpen(false)
                void handleTogglePin(skill, 'pin')
              }}
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
      <div className="-mx-1 mt-1 shrink-0 border-t border-border px-1 pt-1 dark:border-border/50">
        <button
          type="button"
          onClick={() => {
            // Close the menu synchronously before opening the create surface
            // so the two never race — same invariant SearchableMenu's
            // footerAction enforces (this menu is a bespoke ResponsivePopover
            // row, so it can't reuse that component).
            flushSync(() => setAddOpen(false))
            openCreateItem({ kind: 'skill' })
          }}
          className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[length:var(--font-size-body)] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Plus className="size-4" />
          New Skill
        </button>
      </div>
    </>
  )

  const addMenu = (
    <ResponsivePopover
      open={addOpen}
      onOpenChange={setAddOpen}
      title="Add a skill"
      // TooltipTrigger sits between the menu trigger slot and the button so
      // both Radix roots merge their props onto the one real element.
      trigger={pinCapReached ? <TooltipTrigger asChild>{addButton}</TooltipTrigger> : addButton}
      desktopMenu={{
        side: 'top',
        align: 'start',
        sideOffset: 8,
        collisionPadding: 12,
        className: 'w-60 max-w-[calc(100vw-1.5rem)] p-0',
      }}
      mobileMenu={{ initialFocus: false }}
    >
      <div className="flex min-h-0 flex-col p-1">{addMenuContent}</div>
    </ResponsivePopover>
  )

  const addControl = pinCapReached ? (
    <Tooltip>
      {addMenu}
      <TooltipContent>{`Pin limit reached (${maxPinnedSkills}). Unpin one first.`}</TooltipContent>
    </Tooltip>
  ) : (
    addMenu
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
            onClick={() => onAddToChat(skill)}
            onAddInstruction={() => onAddInstruction(skill.instruction)}
            onEdit={isWidgetSkillId(skill.id) ? undefined : () => openCreateItem({ kind: 'skill', skillId: skill.id })}
            onReorder={
              isWidgetSkillId(skill.id)
                ? undefined
                : () => {
                    void loadReorderPanel()
                    dispatch({ type: 'REORDER_OPENED' })
                  }
            }
            onUnpin={isWidgetSkillId(skill.id) ? undefined : () => handleTogglePin(skill, 'unpin')}
          />
        ))}
        {addControl}
        {actionError && (
          <p role="alert" className="shrink-0 text-[length:var(--font-size-sm)] text-destructive">
            {actionError}
          </p>
        )}
      </div>
      {isMobile && (
        <MobileCardMenu open={reorderMode} onOpenChange={(open) => !open && closeReorder()} title="Reorder skills">
          {reorderPanel}
        </MobileCardMenu>
      )}
    </>
  )
}
