/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useProductPreviewState } from './use-product-preview-state'
import { SparkBurst } from './spark-burst'
import { ProductDemo } from './product-demo'

const WindowChrome = ({ title }: { title: string }) => (
  <div className="spark-window-chrome" aria-hidden="true">
    <span>
      <i />
      <i />
      <i />
    </span>
    <span>{title}</span>
  </div>
)

export const ProductPreview = () => {
  const { platform, setPlatform, platforms } = useProductPreviewState()

  return (
    <div className="spark-world" id="spark-preview">
      <SparkBurst className="spark-world-burst" />
      <div className="spark-landscape" aria-hidden="true">
        <svg viewBox="0 0 1440 800" preserveAspectRatio="xMidYMax slice" fill="none">
          <path fill="var(--spark-landscape)" d="M0 0h1440v800H0z" />
          <circle cx="720" cy="830" r="760" fill="var(--spark-landscape-outer)" />
          <circle cx="720" cy="830" r="590" fill="var(--spark-landscape-inner)" />
          <circle cx="720" cy="830" r="675" stroke="var(--spark-landscape-line)" strokeOpacity=".14" />
        </svg>
      </div>
      <div className="spark-preview-stage" id="spark-device-view" data-platform={platform} aria-live="polite">
        {platform === 'Desktop' && (
          <div className="spark-product-frame">
            <WindowChrome title="Thunderbolt" />
            <div className="spark-product-view">
              <ProductDemo platform="desktop" />
            </div>
          </div>
        )}
        {platform === 'Mobile' && (
          <div className="spark-phone">
            <div className="spark-phone-camera" aria-hidden="true" />
            <ProductDemo platform="mobile" />
          </div>
        )}
        {platform === 'Terminal' && (
          <div
            className="spark-terminal-window"
            aria-label="Thunderbolt CLI building and running a focus-planning tool"
          >
            <WindowChrome title="focus — thunderbolt" />
            <ProductDemo platform="terminal" />
          </div>
        )}
      </div>
      <div className="spark-device-options" role="group" aria-label="Preview a Thunderbolt app">
        {platforms.map((item) => (
          <button
            key={item}
            type="button"
            aria-pressed={platform === item}
            aria-controls="spark-device-view"
            onClick={() => setPlatform(item)}
          >
            {item}
          </button>
        ))}
      </div>
    </div>
  )
}
