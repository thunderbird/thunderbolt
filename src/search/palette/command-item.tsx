/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { CommandItem, CommandShortcut } from '@/components/ui/command'
import type { PaletteCommand } from '../commands/types'

/**
 * One non-entity command row: icon, title, and an optional right-aligned
 * shortcut hint. Selecting it hands the whole command back to the palette,
 * which decides whether to navigate or run its side effect.
 */
export const CommandActionItem = ({
  command,
  onSelect,
}: {
  command: PaletteCommand
  onSelect: (command: PaletteCommand) => void
}) => {
  const Icon = command.icon

  return (
    <CommandItem
      // cmdk filters/keys off `value`; fold in the keywords so fuzzy matching
      // covers synonyms, and the id so identical titles stay distinct.
      value={`${command.title} ${(command.keywords ?? []).join(' ')} ${command.id}`}
      onSelect={() => onSelect(command)}
      className="gap-2 rounded-md"
    >
      <Icon className="size-[var(--icon-size-sm)] shrink-0" />
      <span className="truncate text-[length:var(--font-size-body)]">{command.title}</span>
      {command.shortcut ? <CommandShortcut>{command.shortcut}</CommandShortcut> : null}
    </CommandItem>
  )
}
