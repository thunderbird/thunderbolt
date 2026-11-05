/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState } from 'react'
import { SparkBurst } from './spark-burst'
import { ThemedScreenshot } from './themed-screenshot'

const platforms = ['Desktop', 'Mobile', 'Terminal'] as const

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
  const [platform, setPlatform] = useState<(typeof platforms)[number]>('Desktop')

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
              <ThemedScreenshot platform="desktop" />
            </div>
          </div>
        )}
        {platform === 'Mobile' && (
          <div className="spark-phone">
            <div className="spark-phone-camera" aria-hidden="true" />
            <ThemedScreenshot platform="mobile" />
          </div>
        )}
        {platform === 'Terminal' && (
          <div className="spark-terminal-window" aria-label="Illustrative Thunderbolt CLI session">
            <WindowChrome title="book-club — zsh" />
            <div className="spark-terminal-content">
              <p className="spark-terminal-path">~/projects/book-club</p>
              <p className="spark-terminal-command">
                <span className="spark-terminal-prompt">❯</span> thunderbolt{' '}
                <span className="spark-terminal-string">"fix the failing test"</span>
              </p>
              <p className="spark-terminal-response">I’ll find the failure, make the fix, and run the tests.</p>
              <div className="spark-terminal-tools">
                <p>
                  <span className="spark-terminal-tool">read</span> src/picks.ts
                </p>
                <p>
                  <span className="spark-terminal-tool">edit</span> src/picks.ts
                </p>
                <div className="spark-terminal-diff">
                  <p>− return books[index + 1]</p>
                  <p>+ return books[index]</p>
                </div>
                <p>
                  <span className="spark-terminal-tool">bash</span> bun test
                </p>
                <p className="spark-terminal-success">✓ 12 pass · 0 fail</p>
              </div>
              <p className="spark-terminal-response">Fixed the index. All tests pass.</p>
              <p className="spark-terminal-input">
                <span className="spark-terminal-prompt">❯</span>{' '}
                <span className="spark-terminal-cursor" aria-hidden="true" />
              </p>
              <p className="spark-terminal-note">Illustrative session</p>
            </div>
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
