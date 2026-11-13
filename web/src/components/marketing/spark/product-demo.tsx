/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useSiteTheme } from '../../site-theme/use-site-theme'
import { productDemos, type DemoPlatform } from './product-demos'
import { useProductDemoState } from './use-product-demo-state'

export const ProductDemo = ({ platform }: { platform: DemoPlatform }) => {
  const { resolvedTheme: theme } = useSiteTheme()
  const demo = productDemos[platform]
  const { videoRef, hasPlayed, isPlaying, togglePlayback, onPlay, onPlaying, onPause, onError, onEmptied } =
    useProductDemoState(demo[theme].src)
  const imageProps = {
    width: demo.width,
    height: demo.height,
    alt: demo.description,
    decoding: 'async' as const,
    fetchPriority: platform === 'desktop' ? ('high' as const) : ('auto' as const),
  }

  return (
    <div className="spark-demo" style={{ aspectRatio: `${demo.width} / ${demo.height}` }}>
      <div className="spark-demo-poster" aria-hidden={hasPlayed}>
        {import.meta.env.DEV ? (
          <>
            <img data-screenshot-theme="light" src={demo.light.poster} {...imageProps} />
            <img data-screenshot-theme="dark" src={demo.dark.poster} {...imageProps} />
          </>
        ) : (
          <picture>
            <source media="(prefers-color-scheme: dark)" srcSet={demo.dark.poster} />
            <img src={demo.light.poster} {...imageProps} />
          </picture>
        )}
      </div>
      <video
        ref={videoRef}
        className={hasPlayed ? 'spark-demo-video is-visible' : 'spark-demo-video'}
        width={demo.width}
        height={demo.height}
        muted
        loop
        playsInline
        preload="none"
        aria-label={demo.description}
        aria-hidden={!hasPlayed}
        onPlay={onPlay}
        onEmptied={onEmptied}
        onPlaying={onPlaying}
        onPause={onPause}
        onError={onError}
      />
      <button
        type="button"
        className="spark-demo-toggle"
        aria-label={isPlaying ? 'Pause demo' : 'Play demo'}
        title={isPlaying ? 'Pause demo' : 'Play demo'}
        onClick={togglePlayback}
      >
        <svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor" aria-hidden="true">
          {isPlaying ? <path d="M5 4h3v12H5zm7 0h3v12h-3z" /> : <path d="m6 3 11 7-11 7z" />}
        </svg>
      </button>
    </div>
  )
}
