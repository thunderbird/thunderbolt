/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { SparkCliInstall } from './spark-cli-install'
import { mobileStores, productLinks } from '../../../data/website-product'

export const SparkInstall = () => {
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
        <SparkCliInstall />
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
