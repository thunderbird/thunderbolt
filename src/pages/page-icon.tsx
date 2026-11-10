/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppWindow, FileCode2 } from 'lucide-react'
import type { PageSource } from '@shared/page-protocol'
import { BrowserFavicon } from '@/content-view/browser-favicon'

export const PageIcon = ({ source, url, icons }: { source: PageSource; url?: string; icons?: readonly string[] }) =>
  source.kind === 'html' ? (
    <FileCode2 aria-hidden="true" className="size-3.5 shrink-0" />
  ) : source.kind === 'local-app' ? (
    <AppWindow aria-hidden="true" className="size-3.5 shrink-0" />
  ) : (
    <BrowserFavicon url={url ?? source.url} icons={icons} />
  )
