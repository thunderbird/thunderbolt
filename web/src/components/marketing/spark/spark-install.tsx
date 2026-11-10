/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useId } from 'react'
import { useSparkInstallState } from './use-spark-install-state'
import { cliInstallCommand, cliPlatforms, mobileStores, productLinks } from '../../../data/website-product'

export const SparkInstall = () => {
  const { platform, selectPlatform, copyState, copyCommand } = useSparkInstallState()
  const platformGroup = useId()
  const sourceGuide = `${productLinks.cliDocs}#from-source`

  return (
    <div className="spark-install">
      <div className="spark-download-actions">
        <a className="spark-button" href={productLinks.download}>
          Download Thunderbolt <span aria-hidden="true">↓</span>
        </a>
        <a className="spark-text-link" href={productLinks.web}>
          <span className="spark-text-link-label">Try it on the web</span> <span aria-hidden="true">↗</span>
        </a>
      </div>
      <div className="spark-other-platforms">
        <details className="spark-cli-install">
          <summary>
            Install the CLI <span aria-hidden="true">+</span>
          </summary>
          <div className="spark-cli-panel">
            <div className="spark-cli-toolbar">
              <fieldset className="spark-cli-platforms" aria-label="Operating system">
                {cliPlatforms.map((option) => (
                  <label key={option.id}>
                    <input
                      type="radio"
                      name={platformGroup}
                      value={option.id}
                      checked={platform === option.id}
                      onChange={() => selectPlatform(option.id)}
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
              </fieldset>
              {platform !== 'windows' && (
                <button
                  className="spark-cli-copy"
                  type="button"
                  onClick={copyCommand}
                  aria-label={copyState === 'copied' ? 'Copied' : 'Copy command'}
                  title={copyState === 'copied' ? 'Copied' : 'Copy command'}
                >
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    aria-hidden="true"
                  >
                    {copyState === 'copied' ? (
                      <path d="m5 12 4 4L19 6" strokeLinecap="round" strokeLinejoin="round" />
                    ) : (
                      <>
                        <rect x="8" y="8" width="12" height="13" rx="2" />
                        <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
                      </>
                    )}
                  </svg>
                </button>
              )}
            </div>
            {platform === 'windows' ? (
              <div className="spark-cli-source">
                <p>Build the CLI on Windows.</p>
                <span>A Windows installer isn’t available yet. Get started with the source build.</span>
                <a href={sourceGuide}>
                  Build from source <span aria-hidden="true">↗</span>
                </a>
              </div>
            ) : (
              <>
                <div className="spark-cli-command">
                  <span aria-hidden="true">$</span>
                  <pre tabIndex={0} aria-label="Install command">
                    <code>{cliInstallCommand}</code>
                  </pre>
                </div>
                <div className="spark-cli-footer">
                  <span>
                    {platform === 'macos' ? (
                      <>
                        Apple Silicon <span aria-hidden="true">·</span> <a href={sourceGuide}>Intel Mac?</a>
                      </>
                    ) : (
                      'Linux x64 & ARM64'
                    )}
                  </span>
                  <a href={productLinks.cliDocs}>
                    Setup guide <span aria-hidden="true">↗</span>
                  </a>
                </div>
              </>
            )}
          </div>
          <p className="spark-cli-feedback" role="status">
            {copyState === 'failed'
              ? 'Couldn’t copy. Select the command and copy it manually.'
              : copyState === 'copied'
                ? 'Copied. Paste it into your terminal to install.'
                : ''}
          </p>
        </details>
        <div className="spark-mobile-stores" aria-label="Mobile app availability">
          {mobileStores.map((store) => (
            <div key={store.platform}>
              <img src={store.badge} alt={store.store} width={store.badgeWidth} height={44} loading="lazy" />
              <span>{store.status}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
