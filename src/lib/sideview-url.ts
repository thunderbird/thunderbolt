import type { SideviewType } from '../types'

type ParsedSideview = {
  type: SideviewType | null
  id: string | null
}

/**
 * Parses the 'sideview' URL parameter into its type and id components.
 * Expected format: ?sideview=type:id (e.g., ?sideview=message:abc123)
 */
export const parseSideviewParam = (url: URL): ParsedSideview => {
  const sideviewParam = url.searchParams.get('sideview')

  if (!sideviewParam) {
    return { type: null, id: null }
  }

  const colonIndex = sideviewParam.indexOf(':')

  if (colonIndex === -1) {
    return { type: null, id: null }
  }

  const type = sideviewParam.substring(0, colonIndex)
  const id = sideviewParam.substring(colonIndex + 1)

  if (!type || !id) {
    return { type: null, id: null }
  }

  return {
    type: type as SideviewType,
    id: decodeURIComponent(id),
  }
}
