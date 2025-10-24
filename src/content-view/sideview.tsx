import { EmailThreadView } from './thread'
import { useQuery } from '@tanstack/react-query'
import { useSideview } from './context'

/**
 * Sideview component - displays content based on sideview type
 */
export function Sideview() {
  const { sideviewId, sideviewType } = useSideview()

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
