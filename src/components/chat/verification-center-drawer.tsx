/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import type { TinfoilVerification } from '@/hooks/use-tinfoil-verification'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { useCallback, useEffect, useRef, useState } from 'react'

// The hosted Verification Center widget — visually identical to what Tinfoil
// ships and what tinfoil-webapp embeds. We feed it the verification document
// over postMessage rather than rebuilding the (detailed) attestation UI.
const verificationCenterBaseUrl = 'https://verification-center.tinfoil.sh'
const verificationCenterOrigin = new URL(verificationCenterBaseUrl).origin

// Mirrors tinfoil-webapp's send schedule: post immediately, then a few backoff
// retries to survive the iframe's own init races.
const sendRetryDelaysMs = [100, 300, 800, 2000]

const resolveIsDarkMode = (theme: 'light' | 'dark' | 'system'): boolean => {
  if (theme === 'dark') {
    return true
  }
  if (theme === 'light') {
    return false
  }
  return typeof window !== 'undefined' && (window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? false)
}

type VerificationCenterFrameProps = {
  verification: TinfoilVerification
  onClose: () => void
  isDarkMode: boolean
}

/**
 * The iframe + postMessage bridge. Lives inside SheetContent so Radix unmounts
 * it on close and remounts it on open — `isReady` therefore resets per open and
 * the handshake re-runs against the fresh iframe with no manual reset.
 */
const VerificationCenterFrame = ({ verification, onClose, isDarkMode }: VerificationCenterFrameProps) => {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [isReady, setIsReady] = useState(false)
  const { doc, retry } = verification

  // Keep callbacks/values the message listener needs in refs so the listener
  // effect mounts once (stable deps) and never reads a stale closure.
  const retryRef = useRef(retry)
  retryRef.current = retry
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== verificationCenterOrigin) {
        return
      }
      const type = (event.data as { type?: string } | null)?.type
      if (type === 'TINFOIL_VERIFICATION_CENTER_READY') {
        setIsReady(true)
      } else if (type === 'TINFOIL_VERIFICATION_CENTER_CLOSED') {
        onCloseRef.current()
      } else if (type === 'TINFOIL_REQUEST_VERIFICATION_DOCUMENT') {
        retryRef.current()
      }
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [])

  // Tell the widget the panel is open once it's ready (matches tinfoil-webapp's
  // protocol). The frame only exists while the drawer is open, so ready ⇒ open;
  // closing unmounts the iframe, which is the close signal.
  useEffect(() => {
    if (!isReady || !iframeRef.current) {
      return
    }
    iframeRef.current.contentWindow?.postMessage({ type: 'TINFOIL_VERIFICATION_CENTER_OPEN' }, verificationCenterOrigin)
  }, [isReady])

  // Push the document once both sides are ready, re-pushing if the doc updates
  // (e.g. verifying → verified) while the drawer is open.
  useEffect(() => {
    if (!isReady || !doc || !iframeRef.current) {
      return
    }
    const send = () => {
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'TINFOIL_VERIFICATION_DOCUMENT', document: doc },
        verificationCenterOrigin,
      )
    }
    send()
    const timers = sendRetryDelaysMs.map((ms) => setTimeout(send, ms))
    return () => timers.forEach(clearTimeout)
  }, [isReady, doc])

  const iframeUrl = `${verificationCenterBaseUrl}?darkMode=${isDarkMode}&showVerificationFlow=true&compact=false&open=true`

  return (
    <iframe
      ref={iframeRef}
      src={iframeUrl}
      title="Tinfoil Verification Center"
      className="min-h-0 w-full flex-1 border-0"
      onLoad={() => setIsReady(true)}
      // Thunderbolt is cross-origin isolated (COEP: credentialless, set in
      // vite.config.ts for PowerSync's SharedArrayBuffer). A COEP-isolated parent
      // blocks any cross-origin iframe that doesn't assert CORP/COEP — the hosted
      // widget asserts neither, so without this it fails with ERR_BLOCKED_BY_RESPONSE
      // ("refused to connect"). `credentialless` loads it in an ephemeral, cookie-less
      // context that satisfies COEP; safe here since the widget is fed via postMessage,
      // not cookies. (Not yet in React's iframe types — hence the spread.)
      {...({ credentialless: '' } as Record<string, string>)}
    />
  )
}

type VerificationCenterDrawerProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  verification: TinfoilVerification
}

/**
 * Right-side drawer hosting the Verification Center. Mounted near the composer;
 * SheetContent is portaled + fixed so it overlays the whole app like a right
 * rail (there is no persistent right rail today).
 */
export const VerificationCenterDrawer = ({ open, onOpenChange, verification }: VerificationCenterDrawerProps) => {
  const handleClose = useCallback(() => onOpenChange(false), [onOpenChange])
  const theme = useLocalSettingsStore((s) => s.theme)
  const isDarkMode = resolveIsDarkMode(theme)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[90vw] gap-0 p-0 sm:max-w-[400px]" aria-describedby={undefined}>
        <SheetHeader className="sr-only">
          <SheetTitle>Verification Center</SheetTitle>
        </SheetHeader>
        {/* Remount the frame when the theme flips so the iframe reloads with the
            matching darkMode — the widget reads it only from the URL. */}
        <VerificationCenterFrame
          key={isDarkMode ? 'dark' : 'light'}
          verification={verification}
          onClose={handleClose}
          isDarkMode={isDarkMode}
        />
      </SheetContent>
    </Sheet>
  )
}
