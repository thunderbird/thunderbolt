/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/test-utils/framer-motion-mock'
import { SidebarProvider } from '@/components/ui/sidebar'
import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import type { ReactNode } from 'react'
import { SidebarNavToggle } from './nav-toggle'
import type { SidebarSection } from './types'

const Wrapper = ({ children }: { children: ReactNode }) => <SidebarProvider>{children}</SidebarProvider>

const renderToggle = ({
  activeSection = 'chats' as SidebarSection,
  showTasks = true,
  onSectionChange = () => {},
} = {}) =>
  render(<SidebarNavToggle activeSection={activeSection} showTasks={showTasks} onSectionChange={onSectionChange} />, {
    wrapper: Wrapper,
  })

describe('SidebarNavToggle', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders Chats, Tasks and Settings segments when tasks are enabled', () => {
    renderToggle({ showTasks: true })

    expect(screen.getByLabelText('Chats')).toBeInTheDocument()
    expect(screen.getByLabelText('Tasks')).toBeInTheDocument()
    expect(screen.getByLabelText('Settings')).toBeInTheDocument()
  })

  it('hides the Tasks segment when the feature is disabled', () => {
    renderToggle({ showTasks: false })

    expect(screen.getByLabelText('Chats')).toBeInTheDocument()
    expect(screen.queryByLabelText('Tasks')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Settings')).toBeInTheDocument()
  })

  it('marks the active section with aria-current', () => {
    renderToggle({ activeSection: 'settings' })

    expect(screen.getByLabelText('Settings')).toHaveAttribute('aria-current', 'page')
    expect(screen.getByLabelText('Chats')).not.toHaveAttribute('aria-current')
  })

  it('calls onSectionChange when selecting a different section', () => {
    const onSectionChange = mock()
    renderToggle({ activeSection: 'chats', onSectionChange })

    fireEvent.click(screen.getByLabelText('Settings'))

    expect(onSectionChange).toHaveBeenCalledWith('settings')
  })

  it('does not call onSectionChange when re-selecting the active section', () => {
    const onSectionChange = mock()
    renderToggle({ activeSection: 'chats', onSectionChange })

    fireEvent.click(screen.getByLabelText('Chats'))

    expect(onSectionChange).not.toHaveBeenCalled()
  })
})
