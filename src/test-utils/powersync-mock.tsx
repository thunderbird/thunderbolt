import { PowerSyncContext } from '@powersync/react'
import { type ReactNode } from 'react'

/**
 * Minimal PowerSync mock for tests.
 * Satisfies the interface required by @powersync/tanstack-react-query's useQuery:
 * - resolveTables, registerListener, onChangeWithCallback for change tracking
 * - getAll for raw SQL queries (returns [] — our code uses CompilableQuery which calls execute() on the Drizzle query)
 *
 * Used when tests run with bun-sqlite (no real PowerSync). Components using
 * useQuery from @powersync/tanstack-react-query need PowerSyncContext.Provider.
 */
const createPowerSyncMock = () => {
  const resolveTables = async (): Promise<string[]> => []
  const registerListener = () => () => {}
  const onChangeWithCallback = () => () => {}
  const getAll = async <T,>(): Promise<T[]> => []

  return {
    resolveTables,
    registerListener,
    onChangeWithCallback,
    getAll,
    syncStream: () => ({
      subscribe: async () => ({
        unsubscribe: () => {},
        subscription: { hasSynced: true },
      }),
    }),
    waitForStatus: async () => {},
  }
}

const powerSyncMock = createPowerSyncMock()

type PowerSyncMockProviderProps = {
  children: ReactNode
}

/**
 * Wraps children with PowerSyncContext.Provider using a mock PowerSync instance.
 * Use this in tests when components (or their children) use useQuery from
 * @powersync/tanstack-react-query.
 *
 * @example
 * ```tsx
 * render(<MyComponent />, {
 *   wrapper: ({ children }) => (
 *     <PowerSyncMockProvider>
 *       <QueryClientProvider client={queryClient}>
 *         {children}
 *       </QueryClientProvider>
 *     </PowerSyncMockProvider>
 *   )
 * })
 * ```
 */
export const PowerSyncMockProvider = ({ children }: PowerSyncMockProviderProps) => (
  <PowerSyncContext.Provider value={powerSyncMock as never}>{children}</PowerSyncContext.Provider>
)
