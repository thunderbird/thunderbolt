/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Loader2 } from 'lucide-react'
import { type FC, useEffect, useState } from 'react'
import { markSpinnerMounted } from '@/lib/init-timing'

type LoadingProps = {
  className?: string
  size?: number
}

export const Loading: FC<LoadingProps> = ({ className, size = 24 }) => {
  // Startup, auth and route loading mount separate spinners. Share their phase
  // so replacing one with another doesn't visibly restart the rotation.
  const [animationDelay] = useState(() => `${-(performance.now() % 1000)}ms`)
  useEffect(markSpinnerMounted, [])
  return (
    <div className="flex items-center justify-center w-full h-[100vh]">
      <Loader2
        className={`animate-spin text-gray-500 ${className || ''}`}
        style={{ animationDelay, animationDuration: '1s' }}
        size={size}
      />
    </div>
  )
}

export const PageFallback: FC = () => (
  <div className="flex items-center justify-center h-full w-full">
    <Loader2 className="animate-spin text-muted-foreground" size={24} />
  </div>
)

export default Loading
