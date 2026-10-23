/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useConfigStore } from '@/api/config-store'
import { clearBrandingLogos, syncBrandingLogos } from '@/lib/branding-logo'
import { selectBranding } from '@/lib/branding-selectors'
import { createRecordingClient } from '@/test-utils/http-client'
import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'
import { AppLogo } from './app-logo'

const light = { file: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.svg', type: 'image/svg+xml' as const }

describe('AppLogo', () => {
  afterEach(() => {
    useConfigStore.setState({ config: {} })
    clearBrandingLogos()
  })

  it('shows the bundled mark, named after the app', () => {
    useConfigStore.setState({ config: { branding: { appName: 'Acme' } } })
    render(<AppLogo size={20} />)

    const logo = screen.getByRole('img', { name: 'Acme' })
    expect(logo).toHaveAttribute('width', '20')
    expect(logo.getAttribute('src')).not.toStartWith('data:')
  })

  it('holds a blank of the same size while a configured logo downloads, so the bundled mark never flashes', () => {
    useConfigStore.setState({ config: { branding: { logo: { light } } } })
    const { container } = render(<AppLogo size={20} />)

    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    const placeholder = container.querySelector('span[aria-hidden="true"]')
    expect(placeholder).toHaveStyle({ width: '20px', height: '20px' })
  })

  it('shows the downloaded logo once it lands', async () => {
    useConfigStore.setState({ config: { branding: { appName: 'Acme', logo: { light } } } })
    render(<AppLogo />)

    const manifest = selectBranding(useConfigStore.getState().config)?.logo
    const { client } = createRecordingClient((path) =>
      path === `config/branding/${light.file}` ? '<svg/>' : undefined,
    )
    await act(() => syncBrandingLogos(manifest, client))

    expect(screen.getByRole('img', { name: 'Acme' }).getAttribute('src')).toBe(
      `data:image/svg+xml;base64,${btoa('<svg/>')}`,
    )
  })
})
