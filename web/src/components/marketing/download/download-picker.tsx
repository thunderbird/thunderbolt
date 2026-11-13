/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  desktopPlatforms,
  latestReleasePage,
  type DetectedPlatform,
  type DownloadRelease,
  type InstallerId,
} from './downloads'
import { InstallerLink } from './installer-link'
import './download-picker.css'
import { productLinks } from '../../../data/website-product'

type PickerProps = {
  /** `undefined` until the page has hydrated and the platform can be read. */
  detectedPlatform: DetectedPlatform | undefined
  release: DownloadRelease
  continueToDownloadPage?: boolean
}

type DesktopPlatform = (typeof desktopPlatforms)[number]

/** What the main button offers: the visitor's installer when there is one for them in this release. */
const primaryAction = (
  detectedPlatform: PickerProps['detectedPlatform'],
  platform: DesktopPlatform | undefined,
  href: string | undefined,
): { href: string; text: string; arrow: string; installerId?: InstallerId } => {
  if (!detectedPlatform) return { href: latestReleasePage, text: 'Download Thunderbolt', arrow: '↓' }
  if (!platform) return { href: productLinks.web, text: 'Open Thunderbolt on the web', arrow: '↗' }
  if (!href) return { href: latestReleasePage, text: 'View release downloads', arrow: '↗' }
  return { href, text: `Download for ${platform.name}`, arrow: '↓', installerId: platform.installers[0].id }
}

export const DownloadPicker = ({
  detectedPlatform,
  release,
  continueToDownloadPage = false,
}: PickerProps) => {
  const platform = desktopPlatforms.find((item) => item.id === detectedPlatform)
  const recommended = platform?.installers[0]
  const href = recommended && release.downloads[recommended.id]
  const primary = primaryAction(detectedPlatform, platform, href)
  // Mac and Windows installers differ by chip, which their label names. The Linux ones share
  // a chip and differ by package, so naming the recommended one takes both parts.
  const variant =
    recommended && (detectedPlatform === 'linux' ? `${recommended.label} · ${recommended.format}` : recommended.label)

  return (
    <div className="download-picker">
      <div className="download-primary-action">
        <InstallerLink
          className="spark-button"
          href={primary.href}
          installerId={primary.installerId}
          continueToDownloadPage={continueToDownloadPage}
        >
          {primary.text} <span aria-hidden="true">{primary.arrow}</span>
        </InstallerLink>
      </div>
      {(detectedPlatform === 'ios' || detectedPlatform === 'android') && (
        <p className="download-mobile-note">iOS and Android apps are coming soon.</p>
      )}
      <details className="download-options">
        <summary>
          {variant ?? 'Other options'}{' '}
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" aria-hidden="true">
            <path
              d="m4 6 4 4 4-4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </summary>
        <div className="download-options-panel">
          <div className="download-options-grid">
            {desktopPlatforms.map(({ id, name, installers }) => (
              <section key={id} aria-label={`${name} downloads`}>
                <h2>{name}</h2>
                <div className="download-option-links">
                  {installers.map((installer) => {
                    const url = release.downloads[installer.id]
                    return (
                      <InstallerLink
                        key={installer.id}
                        href={url ?? latestReleasePage}
                        installerId={url ? installer.id : undefined}
                        continueToDownloadPage={continueToDownloadPage}
                        aria-label={
                          url
                            ? `Download ${name} ${installer.label} ${installer.format}`
                            : `Find ${name} ${installer.label} on the release page`
                        }
                      >
                        <span>{installer.label}</span> <small>{installer.format}</small>{' '}
                        <span aria-hidden="true">{url ? '↓' : '↗'}</span>
                      </InstallerLink>
                    )
                  })}
                </div>
              </section>
            ))}
          </div>
          <div className="download-options-footer">
            <details className="download-chip-help">
              <summary>Which Mac download?</summary>
              <p>
                Open Apple menu → About This Mac. Choose Apple Silicon for an M-series chip, or Intel for an Intel
                processor.
              </p>
            </details>
            <a href={latestReleasePage}>
              {release.version} · Release notes <span aria-hidden="true">↗</span>
            </a>
          </div>
        </div>
      </details>
      {recommended && !href && (
        <p className="download-feedback" role="status">
          This installer isn’t in the latest release. Check the release page for other options.
        </p>
      )}
    </div>
  )
}
