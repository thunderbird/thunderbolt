/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { desktopPlatforms, installers, releasesUrl, type DetectedPlatform } from './downloads'
import type { ReleaseState } from './use-download-state'
import { InstallerLink } from './installer-link'
import './download-picker.css'
import { productLinks } from '../../../data/website-product'

type PickerProps = {
  detectedPlatform: DetectedPlatform
  releaseState: ReleaseState
  continueToDownloadPage?: boolean
}

export const DownloadPicker = ({ detectedPlatform, releaseState, continueToDownloadPage = false }: PickerProps) => {
  const installer = installers.find((item) => item.platform === detectedPlatform)
  const platformName = desktopPlatforms.find((item) => item.id === detectedPlatform)?.name
  const release = releaseState.status === 'ready' ? releaseState.release : null
  const href = installer ? release?.downloads[installer.id] : undefined
  const mobile = detectedPlatform === 'ios' || detectedPlatform === 'android'
  const variant = installer ? (detectedPlatform === 'linux' ? 'AppImage · x64' : installer.label) : null

  return (
    <div className="download-picker">
      <div className="download-primary-action">
        {!installer ? (
          <a className="spark-button" href={productLinks.web}>
            Open Thunderbolt on the web <span aria-hidden="true">↗</span>
          </a>
        ) : releaseState.status === 'loading' ? (
          <button className="spark-button" disabled>
            Preparing download…
          </button>
        ) : (
          <InstallerLink
            className="spark-button"
            href={href ?? releasesUrl}
            installerId={href ? installer.id : undefined}
            continueToDownloadPage={continueToDownloadPage}
          >
            {href ? `Download for ${platformName}` : 'View release downloads'} <span aria-hidden="true">↓</span>
          </InstallerLink>
        )}
      </div>
      {mobile && <p className="download-mobile-note">iOS and Android apps are coming soon.</p>}
      <details className="download-options">
        <summary>
          {variant && (
            <span className="download-variant">
              {variant} <span aria-hidden="true">·</span>
            </span>
          )}
          Other options{' '}
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
            {desktopPlatforms.map((platform) => (
              <section key={platform.id} aria-label={`${platform.name} downloads`}>
                <h2>{platform.name}</h2>
                <div className="download-option-links">
                  {installers
                    .filter((item) => item.platform === platform.id)
                    .map((option) => {
                      const url = release?.downloads[option.id]
                      return (
                        <InstallerLink
                          key={option.id}
                          href={url ?? releasesUrl}
                          installerId={url ? option.id : undefined}
                          continueToDownloadPage={continueToDownloadPage}
                          aria-label={
                            url
                              ? `Download ${platform.name} ${option.label} ${option.format}`
                              : `Find ${platform.name} ${option.label} on the release page`
                          }
                        >
                          <span>{option.label}</span>
                          <small>{option.format}</small>
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
            <a href={releasesUrl}>
              {release?.version ? `${release.version} · ` : ''}Release notes <span aria-hidden="true">↗</span>
            </a>
          </div>
        </div>
      </details>
      {releaseState.status === 'failed' && installer && (
        <p className="download-feedback" role="status">
          We couldn’t load the latest installers. The release page has all downloads.
        </p>
      )}
      {release && installer && !href && (
        <p className="download-feedback" role="status">
          This installer isn’t in the latest release. Check the release page for other options.
        </p>
      )}
    </div>
  )
}
