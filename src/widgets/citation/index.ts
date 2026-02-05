export { CitationBadge } from '@/components/chat/citation-badge'
export { Component, CitationWidgetComponent } from './widget'
export { instructions } from './instructions'
export { parse, schema } from './schema'
export type { CitationWidget } from './schema'

// No CacheData for citation widget - sources are passed directly in widget args
export type CacheData = never
