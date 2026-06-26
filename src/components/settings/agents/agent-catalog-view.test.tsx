/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'
import type { RegistryEntry } from '@/types/registry'
import { AgentCatalogView } from './agent-catalog-view'

const entry = (overrides: Partial<RegistryEntry> & Pick<RegistryEntry, 'id' | 'name'>): RegistryEntry => ({
  version: '1.2.3',
  description: `${overrides.name} description`,
  authors: ['Author Inc.'],
  license: 'Apache-2.0',
  website: `https://example.com/${overrides.id}`,
  repository: `https://github.com/example/${overrides.id}`,
  distribution: { npx: { package: `${overrides.id}@1.2.3` } },
  ...overrides,
})

const fixtures: ReadonlyArray<RegistryEntry> = [
  entry({ id: 'goose', name: 'goose', description: 'Extensible agent from Block', icon: 'https://cdn/goose.svg' }),
  entry({ id: 'gemini', name: 'Gemini CLI', description: 'Google terminal agent' }),
]

const renderCatalog = (entries: ReadonlyArray<RegistryEntry> = fixtures) =>
  render(<AgentCatalogView entries={entries} />)

describe('AgentCatalogView', () => {
  afterEach(cleanup)

  it('renders one card per entry', () => {
    renderCatalog()
    expect(screen.getByTestId('agent-catalog-card-goose')).toBeInTheDocument()
    expect(screen.getByTestId('agent-catalog-card-gemini')).toBeInTheDocument()
  })

  it('renders a distribution badge per card', () => {
    renderCatalog()
    expect(screen.getAllByText('Node.js')).toHaveLength(fixtures.length)
  })

  it('renders Website and Source link-outs with correct attributes', () => {
    renderCatalog([entry({ id: 'goose', name: 'goose' })])
    const card = screen.getByTestId('agent-catalog-card-goose')
    const links = card.querySelectorAll('a')
    expect(links).toHaveLength(2)

    const website = card.querySelector('a[href="https://example.com/goose"]')
    const source = card.querySelector('a[href="https://github.com/example/goose"]')
    expect(website).toBeInTheDocument()
    expect(source).toBeInTheDocument()

    for (const link of [website, source]) {
      expect(link).toHaveAttribute('target', '_blank')
      expect(link?.getAttribute('rel')).toContain('noopener')
      expect(link?.getAttribute('rel')).toContain('noreferrer')
    }
  })

  it('falls back the Website link to the repository when no website is set, and hides the duplicate Source link', () => {
    renderCatalog([entry({ id: 'claude-acp', name: 'Claude Agent', website: undefined })])
    const card = screen.getByTestId('agent-catalog-card-claude-acp')
    const links = card.querySelectorAll('a')
    expect(links).toHaveLength(1)
    expect(card.querySelector('a[href="https://github.com/example/claude-acp"]')).toBeInTheDocument()
  })

  it('filters by search query', () => {
    renderCatalog()
    fireEvent.change(screen.getByPlaceholderText('Search agents'), { target: { value: 'gemini' } })

    expect(screen.getByTestId('agent-catalog-card-gemini')).toBeInTheDocument()
    expect(screen.queryByTestId('agent-catalog-card-goose')).not.toBeInTheDocument()
  })

  it('clears the query and restores every card when the clear button is clicked', () => {
    renderCatalog()
    const input = screen.getByPlaceholderText('Search agents') as HTMLInputElement

    fireEvent.change(input, { target: { value: 'gemini' } })
    expect(input.value).toBe('gemini')
    expect(screen.queryByTestId('agent-catalog-card-goose')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /clear search/i }))

    expect(input.value).toBe('')
    expect(screen.getByTestId('agent-catalog-card-gemini')).toBeInTheDocument()
    expect(screen.getByTestId('agent-catalog-card-goose')).toBeInTheDocument()
  })

  it('shows a no-results message when nothing matches', () => {
    renderCatalog()
    fireEvent.change(screen.getByPlaceholderText('Search agents'), { target: { value: 'zzzqqqxx' } })

    expect(screen.getByText(/no agents found/i)).toBeInTheDocument()
    expect(screen.queryByTestId('agent-catalog-card-goose')).not.toBeInTheDocument()
  })

  it('renders an icon image when icon is set', () => {
    renderCatalog([entry({ id: 'goose', name: 'goose', icon: 'https://cdn/goose.svg' })])
    const header = screen.getByTestId('agent-catalog-card-goose').querySelector('[data-slot="card-header"]')
    const img = header?.querySelector('img')
    expect(img).toBeInTheDocument()
    expect(img).toHaveAttribute('src', 'https://cdn/goose.svg')
    // The Terminal fallback (an svg) must not render while the icon image loads cleanly.
    expect(header?.querySelector('svg')).not.toBeInTheDocument()
  })

  it('falls back to the Terminal icon when the image fails to load', () => {
    renderCatalog([entry({ id: 'goose', name: 'goose', icon: 'https://cdn/broken.svg' })])
    const header = screen.getByTestId('agent-catalog-card-goose').querySelector('[data-slot="card-header"]')
    const img = header?.querySelector('img')
    expect(img).toBeInTheDocument()

    fireEvent.error(img as HTMLImageElement)

    expect(header?.querySelector('img')).not.toBeInTheDocument()
    expect(header?.querySelector('svg')).toBeInTheDocument()
  })

  it('renders the Terminal icon when no icon is set', () => {
    renderCatalog([entry({ id: 'goose', name: 'goose', icon: undefined })])
    const header = screen.getByTestId('agent-catalog-card-goose').querySelector('[data-slot="card-header"]')
    expect(header?.querySelector('img')).not.toBeInTheDocument()
    expect(header?.querySelector('svg')).toBeInTheDocument()
  })

  it('exposes only link-out actions per card, never an install action', () => {
    renderCatalog([entry({ id: 'goose', name: 'goose' })])
    const card = screen.getByTestId('agent-catalog-card-goose')

    expect(card.querySelectorAll('a').length).toBeGreaterThan(0)
    expect(card.querySelector('button')).not.toBeInTheDocument()
    expect(card.querySelector('button[type="submit"]')).not.toBeInTheDocument()
  })

  it('keeps all cards visible for a whitespace-only query', () => {
    renderCatalog()
    fireEvent.change(screen.getByPlaceholderText('Search agents'), { target: { value: '   ' } })

    expect(screen.queryByText(/no agents found/i)).not.toBeInTheDocument()
    expect(screen.getByTestId('agent-catalog-card-goose')).toBeInTheDocument()
    expect(screen.getByTestId('agent-catalog-card-gemini')).toBeInTheDocument()
  })
})
