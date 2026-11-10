/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { DownloadRelease } from './downloads'

import '@fontsource-variable/lora'
import '../spark/spark.css'
import './download.css'
import { mobileStores, productLinks } from '../../../data/website-product'
import { SparkHeader } from '../spark/spark-header'
import { SparkFooter } from '../spark/spark-footer'
import { SparkBurst } from '../spark/spark-burst'
import { SparkCliInstall } from '../spark/spark-cli-install'
import { ProductDemo } from '../spark/product-demo'
import { productDemos } from '../spark/product-demos'
import { DownloadPicker } from './download-picker'
import { DownloadArrival } from './download-arrival'
import { useDownloadState } from './use-download-state'

const desktop = productDemos.desktop
const cornerMask = `inset(0 round ${(desktop.cornerRadius / desktop.width) * 100}% / ${(desktop.cornerRadius / desktop.height) * 100}%)`

export const DownloadPage = ({ release }: { release?: DownloadRelease }) => {
  const downloads = useDownloadState(release)

  return (
    <div className="spark-page download-page">
      <a className="spark-skip" href="#download-main">
        Skip to content
      </a>
      <SparkHeader />
      <main id="download-main" className="spark-shell">
        <section className="download-hero" aria-labelledby="download-title">
          <DownloadArrival releaseState={downloads.releaseState} />
          <h1 id="download-title">
            Good ideas
            <br />
            <span className="spark-heading-accent">go places.</span>
          </h1>
          <p className="download-intro">
            Your open-source AI workspace. At your desk, on the go, and wherever curiosity takes you.
          </p>
        </section>

        <div className="download-everywhere">
          <section className="download-browser" aria-labelledby="download-browser-title">
            <div className="download-browser-scene">
              <SparkBurst className="download-burst" />
              <div className="download-window">
                <div className="spark-window-chrome" aria-hidden="true">
                  <span>
                    <i />
                    <i />
                    <i />
                  </span>
                  <span>app.thunderbolt.io</span>
                </div>
                <div className="download-window-content" style={{ clipPath: cornerMask }}>
                  <ProductDemo platform="desktop" />
                </div>
              </div>
            </div>
            <div className="download-device-copy">
              <h2 id="download-browser-title">Just open a tab.</h2>
              <p>Make room for your next idea. No installation needed.</p>
              <a className="spark-text-link" href={productLinks.web}>
                Try Thunderbolt on the web <span aria-hidden="true">↗</span>
              </a>
            </div>
          </section>

          <section className="download-mobile" aria-labelledby="download-mobile-title">
            <div className="download-mobile-scene">
              <div className="spark-phone">
                <span className="spark-phone-camera" aria-hidden="true" />
                <ProductDemo platform="mobile" />
              </div>
            </div>
            <div className="download-device-copy">
              <h2 id="download-mobile-title">A little pocket power.</h2>
              <p>Big ideas don’t wait until you’re at your desk.</p>
              <div className="download-store-links" aria-label="Mobile apps coming soon">
                {mobileStores.map((store) => (
                  <img
                    key={store.platform}
                    src={store.badge}
                    alt={`${store.store} — coming soon`}
                    width={store.badgeWidth}
                    height={44}
                    loading="lazy"
                  />
                ))}
              </div>
              <span className="download-mobile-soon">Coming soon to iOS and Android.</span>
            </div>
          </section>
        </div>

        <section className="download-terminal" aria-labelledby="download-terminal-title">
          <div className="download-terminal-copy">
            <h2 id="download-terminal-title">
              Big ideas.
              <br />
              One command away.
            </h2>
            <p>Bring an AI coding agent to your terminal. Connect a model and get building.</p>
          </div>
          <SparkCliInstall embedded />
        </section>

        <section className="download-desktop" aria-labelledby="download-desktop-title">
          <h2 id="download-desktop-title">Make yourself at home.</h2>
          <p>A place for Thunderbolt on your desktop.</p>
          <DownloadPicker {...downloads} />
        </section>
      </main>
      <SparkFooter />
    </div>
  )
}
