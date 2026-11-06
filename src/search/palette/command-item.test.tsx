/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { Command, CommandList } from '@/components/ui/command'
import { fireEvent, render, screen } from '@testing-library/react'
import { Bot } from 'lucide-react'
import { describe, expect, it, mock } from 'bun:test'
import type { PaletteCommand } from '../commands/types'
import { CommandActionItem } from './command-item'

const command: PaletteCommand = {
  id: 'nav-agents',
  title: 'All agents',
  icon: Bot,
  section: 'navigation',
  keywords: ['bots'],
  shortcut: '⌘B',
  to: '/settings/agents',
}

const renderItem = (onSelect: (command: PaletteCommand) => void) =>
  render(
    <Command>
      <CommandList>
        <CommandActionItem command={command} onSelect={onSelect} />
      </CommandList>
    </Command>,
  )

describe('CommandActionItem', () => {
  it('renders the title and shortcut hint', () => {
    renderItem(() => {})
    expect(screen.getByText('All agents')).toBeInTheDocument()
    expect(screen.getByText('⌘B')).toBeInTheDocument()
  })

  it('hands the whole command back on select', () => {
    const onSelect = mock((_command: PaletteCommand) => {})
    renderItem(onSelect)

    fireEvent.click(screen.getByRole('option', { name: /All agents/ }))

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(command)
  })
})
