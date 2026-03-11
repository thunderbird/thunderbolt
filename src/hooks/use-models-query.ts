import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'
import { mapModel } from '@/dal'
import type { Model } from '@/types'
import { useMemo } from 'react'
import type { Query } from 'drizzle-orm'
import type { ModelRow } from '@/types'

type ModelQueryBuilder = {
  execute: () => Promise<ModelRow | ModelRow[]>
  toSQL: () => Query
}

/**
 * Wraps a Drizzle model query builder with PowerSync's reactive useQuery and maps rows to Model[].
 * Eliminates the repeated `useMemo(() => data.map(mapModel), [data])` pattern.
 */
export const useModelsQuery = (
  queryKey: string[],
  queryBuilder: ModelQueryBuilder,
  options?: { enabled?: boolean },
) => {
  const { data = [], ...rest } = useQuery({
    queryKey,
    query: toCompilableQuery(queryBuilder),
    ...options,
  })

  const models: Model[] = useMemo(() => (data ? [data].flat().map(mapModel) : []), [data])

  return { models, ...rest }
}
