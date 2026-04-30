/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export { CitationBadge } from '@/components/chat/citation-badge'
export { Component, CitationWidgetComponent } from './widget'
export { instructions } from './instructions'
export { parse, schema } from './schema'
export type { CitationWidget } from './schema'

// No CacheData for citation widget - sources are passed directly in widget args
export type CacheData = never
