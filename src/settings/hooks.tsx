import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { DatabaseSingleton } from '@/db/singleton'
import { settingsTable } from '@/db/tables'
import { eq } from 'drizzle-orm'

export function useSetting<T = string>(
  key: string
): {
  value: T | null
  isLoading: boolean
  setValue: (value: T) => Promise<void>
} {
  const queryClient = useQueryClient()

  const { data: value, isLoading } = useQuery<T | null>({
    queryKey: ['settings', key],
    queryFn: async () => {
      const db = DatabaseSingleton.instance.db
      const setting = await db.select().from(settingsTable).where(eq(settingsTable.key, key)).get()
      if (!setting) return null
      return setting.value as T
    },
  })

  const mutation = useMutation({
    mutationFn: async (updatedValue: T) => {
      const db = DatabaseSingleton.instance.db
      await db
        .insert(settingsTable)
        .values({
          key,
          value: updatedValue as unknown as string,
        })
        .onConflictDoUpdate({
          target: settingsTable.key,
          set: { value: updatedValue as unknown as string },
        })
    },
    onMutate: async (updatedValue) => {
      await queryClient.cancelQueries({ queryKey: ['settings', key] })
      const previousValue = queryClient.getQueryData(['settings', key])
      queryClient.setQueryData(['settings', key], updatedValue)
      return { previousValue }
    },
  })

  const setValue = async (value: T) => {
    await mutation.mutateAsync(value)
  }

  return {
    value: value as T | null,
    isLoading,
    setValue,
  }
}
