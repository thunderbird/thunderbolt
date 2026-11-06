/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState } from 'react'

/** Browser autoplay policies can refuse playback; the play button remains available. */
const playVideo = async (video: HTMLVideoElement, source: string) => {
  if (!video.getAttribute('src')) video.src = source
  try {
    await video.play()
  } catch {
    // A blocked autoplay or an interrupted load leaves the still poster visible.
  }
}

/** Keep one demo in sync with visibility, reduced motion, and the visitor's pause choice. */
export const useProductDemoState = (source: string) => {
  const videoRef = useRef<HTMLVideoElement>(null)
  const playbackIntent = useRef<'auto' | 'play' | 'pause'>('auto')
  const [isPlaying, setIsPlaying] = useState(false)
  const [hasPlayed, setHasPlayed] = useState(false)

  useEffect(() => {
    const video = videoRef.current!
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    let visibleRatio = 0

    const updatePlayback = () => {
      const explicitlyPlaying = playbackIntent.current === 'play'
      if (
        visibleRatio <= 0 ||
        document.hidden ||
        playbackIntent.current === 'pause' ||
        (!explicitlyPlaying && (visibleRatio < 0.15 || reducedMotion.matches))
      ) {
        video.pause()
        return
      }
      void playVideo(video, source)
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        visibleRatio = entry.isIntersecting ? entry.intersectionRatio : 0
        updatePlayback()
      },
      { threshold: [0, 0.15] },
    )

    observer.observe(video)
    reducedMotion.addEventListener('change', updatePlayback)
    document.addEventListener('visibilitychange', updatePlayback)
    return () => {
      observer.disconnect()
      reducedMotion.removeEventListener('change', updatePlayback)
      document.removeEventListener('visibilitychange', updatePlayback)
      video.pause()
      video.removeAttribute('src')
      video.load()
    }
  }, [source])

  const togglePlayback = async () => {
    const video = videoRef.current!
    playbackIntent.current = isPlaying ? 'pause' : 'play'
    if (isPlaying) {
      video.pause()
      return
    }
    await playVideo(video, source)
  }

  return {
    videoRef,
    isPlaying,
    hasPlayed,
    togglePlayback,
    onPlay: () => setIsPlaying(true),
    onEmptied: () => {
      setIsPlaying(false)
      setHasPlayed(false)
    },
    onPlaying: () => {
      setIsPlaying(true)
      setHasPlayed(true)
    },
    onPause: () => setIsPlaying(false),
    onError: () => {
      setIsPlaying(false)
      setHasPlayed(false)
    },
  }
}
