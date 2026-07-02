/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import QRCode from 'qrcode'
import { useEffect, useState } from 'react'

type DeviceQrCodeProps = {
  /** The pairing string to encode (see `encodePairingTicket`). */
  value: string
  /** Rendered width/height in pixels. */
  size?: number
}

/**
 * Renders a QR code for a device pairing string. Default export so it can be
 * lazily loaded — the `qrcode` dependency is only pulled in when pairing UI is shown.
 */
export default function DeviceQrCode({ value, size = 160 }: DeviceQrCodeProps) {
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    QRCode.toDataURL(value, { margin: 1, width: size, errorCorrectionLevel: 'M' })
      .then((url) => {
        if (!cancelled) {
          setFailed(false)
          setDataUrl(url)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [value, size])

  if (failed) {
    return <p className="text-[length:var(--font-size-xs)] text-muted-foreground">Could not render pairing code.</p>
  }

  return (
    <img
      src={dataUrl ?? undefined}
      alt="Device pairing QR code"
      width={size}
      height={size}
      className="rounded-md bg-white p-2"
      style={{ width: size, height: size }}
    />
  )
}
