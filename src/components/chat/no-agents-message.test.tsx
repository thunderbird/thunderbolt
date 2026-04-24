import { describe, expect, it, beforeEach } from 'bun:test'
import { render, screen, cleanup } from '@testing-library/react'
import { BrowserRouter } from 'react-router'
import type { ReactElement } from 'react'
import { NoAgentsMessage } from './no-agents-message'

const renderWithRouter = (ui: ReactElement) => render(<BrowserRouter>{ui}</BrowserRouter>)

describe('NoAgentsMessage', () => {
  beforeEach(() => {
    cleanup()
  })

  it('renders the no agents message', () => {
    renderWithRouter(<NoAgentsMessage />)
    expect(screen.getByText('No agents enabled')).toBeDefined()
  })

  it('shows a description', () => {
    renderWithRouter(<NoAgentsMessage />)
    expect(screen.getByText(/Enable or install an agent/)).toBeDefined()
  })

  it('shows a button linking to agents settings', () => {
    renderWithRouter(<NoAgentsMessage />)
    const link = screen.getByRole('link', { name: /agents/i })
    expect(link).toBeDefined()
    expect(link.getAttribute('href')).toBe('/settings/agents')
  })
})
