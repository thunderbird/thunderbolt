import { useSideview } from '@/sideview/provider'
import { EmailThreadView } from '@/sideview/thread'
import { useQuery } from '@tanstack/react-query'

/**
 * Sideview component - displays content based on sideview type
 *
 * NOTE: For a dual webview implementation (two webviews side-by-side),
 * see src/layout/sideview-dual.tsx and docs/dual-webview-guide.md
 */
export function Sideview() {
  const { sideviewId, sideviewType } = useSideview()

  console.log('sideviewType', sideviewType, sideviewId)

  const { data: _object } = useQuery({
    queryKey: ['sideview', sideviewType, sideviewId],
    queryFn: async () => {
      if (!sideviewId || !sideviewType) return null

      switch (sideviewType) {
        case 'message':
          // @todo re-implement this
          return null
        case 'thread':
          // @todo re-implement this
          return null
        default:
          return null
      }
    },
    enabled: !!sideviewId && !!sideviewType,
  })

  switch (sideviewType) {
    case 'message':
      return <EmailThreadView />
    case 'thread':
      return <EmailThreadView />
    default:
      return <div>Unsupported sideview type</div>
  }
}
