/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { scrollToMessageStateKey } from '@/chats/scroll-to-message-intent'
import { DeleteAllChatsDialog, type DeleteAllChatsDialogRef } from '@/components/delete-all-chats-dialog'
import { LogoutModal } from '@/components/logout-modal'
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandList } from '@/components/ui/command'
import { useSidebar } from '@/components/ui/sidebar'
import { useDatabase } from '@/contexts'
import { getModel } from '@/dal'
import { useDebounce } from '@/hooks/use-debounce'
import { useDeleteAllChats } from '@/hooks/use-delete-all-chats'
import { useSettings } from '@/hooks/use-settings'
import { trackEvent as trackEventImpl } from '@/lib/posthog'
import { useCallback, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { buildActionNav } from '../actions/entity-actions'
import type { PaletteCommand } from '../commands/types'
import { useCommands as useCommandsImpl } from '../commands/use-commands'
import { searchEntities } from '../registry'
import type { SearchEntityType, SearchResult } from '../types'
import { useSearch as useSearchImpl } from '../use-search'
import { CommandActionItem } from './command-item'
import { entityLabels } from './entity-meta'
import { SearchResultItem } from './search-result-item'

/** Wait for typing to settle before running FTS, to avoid a query per keystroke. */
const debounceMs = 180

/**
 * Groups results by entity type, preserving the registry's ordering so the
 * palette always lists types in the same, intentional sequence.
 */
const groupByEntity = (results: SearchResult[]) =>
  searchEntities
    .map((entity) => ({ entity, hits: results.filter((result) => result.entityType === entity.type) }))
    .filter((group) => group.hits.length > 0)

/**
 * Matches a static command against the query: every whitespace token must
 * appear (case-insensitive) in the command's title or keywords. cmdk's built-in
 * filter is disabled on the palette (it would also re-filter — and wrongly hide
 * — the already-FTS-filtered result rows), so we filter the command list here.
 */
const commandMatchesQuery = (command: PaletteCommand, query: string): boolean => {
  const haystack = `${command.title} ${command.keywords?.join(' ') ?? ''}`.toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .every((token) => haystack.includes(token))
}

type SearchPaletteProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * Data/analytics dependencies, injected in tests to drive dispatch with canned
   * commands/results and a spy — the component uses the real hooks by default.
   * Keeps the suite from module-mocking these shared modules (which leaks across
   * files under `--randomize`).
   */
  useCommands?: typeof useCommandsImpl
  useSearch?: typeof useSearchImpl
  trackEvent?: typeof trackEventImpl
}

/**
 * The Cmd+K command palette modal. Owns the debounced query, drives `useSearch`,
 * and renders grouped results (or the command groups when the query is empty).
 */
export const SearchPalette = ({
  open,
  onOpenChange,
  useCommands = useCommandsImpl,
  useSearch = useSearchImpl,
  trackEvent = trackEventImpl,
}: SearchPaletteProps) => {
  const navigate = useNavigate()
  const db = useDatabase()
  // No-op on desktop / when the drawer is closed; on mobile it dismisses the
  // sidebar drawer sitting behind the palette before we navigate.
  const { closeMobileSidebar } = useSidebar()
  const [query, setQuery] = useState('')
  const debouncedQuery = useDebounce(query, debounceMs)
  const trimmedQuery = debouncedQuery.trim()
  const hasQuery = trimmedQuery.length > 0

  const { experimentalFeatureTasks } = useSettings({ experimental_feature_tasks: false })

  const { results } = useSearch(hasQuery ? trimmedQuery : '')
  const groups = useMemo(() => {
    if (!hasQuery) {
      return []
    }
    // Tasks stay indexed, but the Tasks result group is hidden when the feature
    // flag is off — `/tasks` isn't mounted then (app.tsx), so a click would 404.
    // Mirrors the flag-gating on the Tasks nav/create commands.
    const visible = experimentalFeatureTasks.value ? results : results.filter((result) => result.entityType !== 'task')
    return groupByEntity(visible)
  }, [hasQuery, results, experimentalFeatureTasks.value])

  const [logoutOpen, setLogoutOpen] = useState(false)
  const deleteAllChatsDialogRef = useRef<DeleteAllChatsDialogRef>(null)
  const deleteAllChats = useDeleteAllChats()

  const commandOpts = useMemo(
    () => ({
      onSignOut: () => setLogoutOpen(true),
      onClearAllChats: () => deleteAllChatsDialogRef.current?.open(),
    }),
    [],
  )
  const commands = useCommands(commandOpts)
  const visibleCommands = hasQuery ? commands.filter((command) => commandMatchesQuery(command, trimmedQuery)) : commands
  const navCommands = visibleCommands.filter((command) => command.section === 'navigation')
  const actionCommands = visibleCommands.filter((command) => command.section === 'actions')
  const createCommands = visibleCommands.filter((command) => command.section === 'create')

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        setQuery('')
      }
      onOpenChange(nextOpen)
    },
    [onOpenChange],
  )

  const handleSelect = useCallback(
    async (to: string, entityType: SearchEntityType, id: string) => {
      handleOpenChange(false)
      // System-only models can't be edited, so skip the edit intent and just
      // land on the models page. Entities with an inline editor (non-system
      // models, skills, agents) open straight into their edit panel; everything
      // else navigates to its page (messages also carry a scroll-to-message intent).
      const isSystemModel = entityType === 'model' && (await getModel(db, id).catch(() => null))?.isSystem === 1
      const editNav = isSystemModel ? null : buildActionNav(entityType, { type: 'edit', id })
      // Dismiss the mobile sidebar drawer behind the palette before navigating.
      await closeMobileSidebar()
      if (editNav) {
        trackEvent('search_result_select', { entityType, jumpToMessage: false })
        navigate(editNav.to, { state: editNav.state })
        return
      }
      const jumpToMessage = entityType === 'message'
      trackEvent('search_result_select', { entityType, jumpToMessage })
      navigate(to, jumpToMessage ? { state: { [scrollToMessageStateKey]: id } } : undefined)
    },
    [handleOpenChange, navigate, trackEvent, db, closeMobileSidebar],
  )

  const handleCommand = useCallback(
    async (command: PaletteCommand) => {
      handleOpenChange(false)
      trackEvent('search_command_run', { commandId: command.id })
      if ('to' in command) {
        // Dismiss the mobile sidebar drawer before navigating (go to page, create…).
        await closeMobileSidebar()
        navigate(command.to, command.state ? { state: command.state } : undefined)
        return
      }
      void Promise.resolve(command.run()).catch((error) => {
        console.error(`[search] command '${command.id}' failed`, error)
      })
    },
    [handleOpenChange, navigate, trackEvent, closeMobileSidebar],
  )

  const handleClearAllChatsConfirm = useCallback(async () => {
    try {
      await deleteAllChats()
      deleteAllChatsDialogRef.current?.close()
    } catch (error) {
      console.error('[search] clear all chats failed', error)
    }
  }, [deleteAllChats])

  const commandSections = (
    <>
      {createCommands.length > 0 ? (
        <CommandGroup heading="Create">
          {createCommands.map((command) => (
            <CommandActionItem key={command.id} command={command} onSelect={handleCommand} />
          ))}
        </CommandGroup>
      ) : null}
      {navCommands.length > 0 ? (
        <CommandGroup heading="Go to">
          {navCommands.map((command) => (
            <CommandActionItem key={command.id} command={command} onSelect={handleCommand} />
          ))}
        </CommandGroup>
      ) : null}
      {actionCommands.length > 0 ? (
        <CommandGroup heading="Actions">
          {actionCommands.map((command) => (
            <CommandActionItem key={command.id} command={command} onSelect={handleCommand} />
          ))}
        </CommandGroup>
      ) : null}
    </>
  )

  return (
    <>
      <CommandDialog
        open={open}
        onOpenChange={handleOpenChange}
        title="Search"
        description="Search across chats, models, skills, agents, and more"
        className="rounded-2xl"
        // FTS already filters result rows and we filter commands manually; cmdk's
        // fuzzy filter would otherwise hide valid stemmed/prefixed FTS matches.
        shouldFilter={false}
      >
        <CommandInput placeholder="Search chats, models, skills, agents…" value={query} onValueChange={setQuery} />
        <CommandList>
          {!hasQuery ? (
            commandSections
          ) : (
            <>
              <CommandEmpty>No results found.</CommandEmpty>
              {commandSections}
              {groups.map(({ entity, hits }) => (
                <CommandGroup key={entity.type} heading={entityLabels[entity.type]}>
                  {hits.map((result) => (
                    <SearchResultItem
                      key={`${result.entityType}-${result.id}`}
                      result={result}
                      query={trimmedQuery}
                      onSelect={handleSelect}
                    />
                  ))}
                </CommandGroup>
              ))}
            </>
          )}
        </CommandList>
      </CommandDialog>
      <LogoutModal open={logoutOpen} onOpenChange={setLogoutOpen} />
      <DeleteAllChatsDialog ref={deleteAllChatsDialogRef} onConfirm={() => void handleClearAllChatsConfirm()} />
    </>
  )
}
