/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ComponentProps } from 'react'
import type { DownloadRelease } from '../download/downloads'
import { useDownloadState } from '../download/use-download-state'
import { SparkHeader } from './spark-header'

type Props = Omit<ComponentProps<typeof SparkHeader>, 'downloads'> & { release: DownloadRelease }

/** Standalone header island for pages without their own download state. */
export const SiteHeader = ({ release, ...props }: Props) => {
  const downloads = useDownloadState(release)
  return <SparkHeader {...props} downloads={downloads} />
}
