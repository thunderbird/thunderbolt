/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useSparkInstallState } from './use-spark-install-state'
import { cliInstallCommand, mobileStores, productLinks } from '../../../data/website-product'

export const SparkInstall = () => {
  const { copyState, copyCommand } = useSparkInstallState()

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
          <div>
            <code>{cliInstallCommand}</code>
            <button type="button" onClick={copyCommand}>
              {copyState === 'copied' ? 'Copied' : 'Copy command'}
            </button>
            <span role="status">
              {copyState === 'failed'
                ? 'Select and copy the command above.'
                : copyState === 'copied'
                  ? 'Ready to paste into your terminal.'
                  : ''}
            </span>
            <a href={productLinks.cliDocs}>CLI documentation ↗</a>
          </div>
        </details>
        <div className="spark-mobile-stores" aria-label="Mobile app availability">
          {mobileStores.map((store) => (
            <div key={store.platform}>
              <strong>{store.store}</strong>
              <span>{store.status}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
