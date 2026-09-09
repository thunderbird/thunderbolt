/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { i18n } from '@lingui/core'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { ExternalLinkToggleGroup, getBehaviorOptions } from './external-link-toggle-group'

// Platform predicates are injected (per docs/development/testing.md: DI over module
// mocks), so the platform matrix is a pure test and the component test runs as web.
const web = { isDesktop: () => false, isTauri: () => false }
const tauriDesktop = { isDesktop: () => true, isTauri: () => true }
const tauriMobile = { isDesktop: () => false, isTauri: () => true }

// Options hold `msg` descriptors, so resolve through i18n rather than reading `.label`.
const labels = (deps: typeof web) => getBehaviorOptions(deps).map((option) => i18n._(option.label))

describe('getBehaviorOptions', () => {
  it('offers Ask and New tab on web — no Sidebar without the side panel', () => {
    expect(labels(web)).toEqual(['Ask', 'New tab'])
  })

  it('offers all three on desktop, with the external option named Browser', () => {
    expect(labels(tauriDesktop)).toEqual(['Ask', 'Sidebar', 'Browser'])
  })

  it('names the external option Browser on Tauri mobile but still omits Sidebar', () => {
    // The label and the Sidebar gate come from two different predicates; this is the
    // combination where conflating them would show a Sidebar option that cannot work.
    expect(labels(tauriMobile)).toEqual(['Ask', 'Browser'])
  })

  it('gives the external option a whole-sentence aria-label per platform', () => {
    // Two complete messages, not "Open in " + label: the fragment build was
    // untranslatable, and this test is what pins that apart.
    const ariaLabel = (deps: typeof web) => {
      const option = getBehaviorOptions(deps).find((o) => o.value === 'browser')
      return option && i18n._(option.ariaLabel)
    }

    expect(ariaLabel(web)).toBe('Open in new tab')
    expect(ariaLabel(tauriDesktop)).toBe('Open in browser')
  })
})

describe('ExternalLinkToggleGroup', () => {
  beforeEach(() => {
    useLocalSettingsStore.getState().setLocalSetting('externalLinkBehavior', 'ask')
  })

  afterEach(() => {
    cleanup()
    // Don't leak a persisted preference into other suites (tests run --randomize
    // in one process, and the store is a module singleton).
    useLocalSettingsStore.getState().setLocalSetting('externalLinkBehavior', 'ask')
  })

  it('renders the platform options with the current behavior selected', () => {
    render(<ExternalLinkToggleGroup />)

    expect(screen.getByRole('radio', { name: 'Always ask' })).toHaveAttribute('data-state', 'on')
    expect(screen.getByRole('radio', { name: 'Open in new tab' })).toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: 'Open in sidebar' })).not.toBeInTheDocument()
  })

  it('selecting an option persists the behavior', () => {
    render(<ExternalLinkToggleGroup />)

    fireEvent.click(screen.getByRole('radio', { name: 'Open in new tab' }))

    expect(useLocalSettingsStore.getState().externalLinkBehavior).toBe('browser')
    expect(screen.getByRole('radio', { name: 'Open in new tab' })).toHaveAttribute('data-state', 'on')
    expect(screen.getByRole('radio', { name: 'Always ask' })).toHaveAttribute('data-state', 'off')
  })

  it('re-clicking the selected option keeps it selected (no deselect to empty)', () => {
    render(<ExternalLinkToggleGroup />)

    fireEvent.click(screen.getByRole('radio', { name: 'Always ask' }))

    expect(useLocalSettingsStore.getState().externalLinkBehavior).toBe('ask')
    expect(screen.getByRole('radio', { name: 'Always ask' })).toHaveAttribute('data-state', 'on')
  })

  it('falls back to Ask when the persisted behavior has no option on this platform', () => {
    // `sidebar` is desktop-only; without the fallback the group renders nothing selected.
    useLocalSettingsStore.getState().setLocalSetting('externalLinkBehavior', 'sidebar')

    render(<ExternalLinkToggleGroup />)

    expect(screen.getByRole('radio', { name: 'Always ask' })).toHaveAttribute('data-state', 'on')
    expect(screen.getByRole('radio', { name: 'Open in new tab' })).toHaveAttribute('data-state', 'off')
  })
})
