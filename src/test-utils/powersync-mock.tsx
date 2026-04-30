/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PowerSyncContext } from '@powersync/react'
import { DatabaseProvider } from '@/contexts/database-context'
import { getDb, isDbRegistered } from '@/db/database'
import {
  createContext,
  type MutableRefObject,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react'

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

type TableChangeSubscription = {
  tables: string[]
  onChange: () => void
}

export type PowerSyncReactivityMock = {
  resolveTables: (sqlStatement: string, params?: unknown[]) => Promise<string[]>
  registerListener: () => () => void
  onChangeWithCallback: (
    callbacks: { onChange: () => void; onError?: (e: unknown) => void },
    options: { tables: string[]; signal?: AbortSignal },
  ) => () => void
  getAll: <T>() => Promise<T[]>
  syncStream: () => {
    subscribe: () => Promise<{
      unsubscribe: () => void
      subscription: { hasSynced: boolean }
    }>
  }
  waitForStatus: () => Promise<void>
  triggerChange: (tables: string[]) => void
}

/**
 * Creates a PowerSync mock that stores onChange callbacks and exposes triggerChange
 * to simulate table changes. Use for reactivity tests.
 *
 * @param options.tables - Table names to return from resolveTables (default: []).
 *   Pass e.g. ['models'] for model queries so onChangeWithCallback receives that table list.
 */
export const createPowerSyncMockWithReactivity = (options?: { tables?: string[] }): PowerSyncReactivityMock => {
  const defaultTables = options?.tables ?? []
  const subscriptions: TableChangeSubscription[] = []

  const resolveTables = async (): Promise<string[]> => [...defaultTables]

  const onChangeWithCallback = (
    callbacks: { onChange: () => void; onError?: (e: unknown) => void },
    opts: { tables: string[]; signal?: AbortSignal },
  ) => {
    const subscription: TableChangeSubscription = {
      tables: opts.tables,
      onChange: callbacks.onChange,
    }
    subscriptions.push(subscription)
    return () => {
      const idx = subscriptions.indexOf(subscription)
      if (idx !== -1) {
        subscriptions.splice(idx, 1)
      }
    }
  }

  const triggerChange = (tables: string[]) => {
    const tableSet = new Set(tables)
    for (const sub of subscriptions) {
      if (sub.tables.some((t) => tableSet.has(t))) {
        sub.onChange()
      }
    }
  }

  const registerListener = () => () => {}
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
    triggerChange,
  }
}

const PowerSyncReactivityContext = createContext<{
  triggerChange: (tables: string[]) => void
} | null>(null)

export const usePowerSyncReactivity = () => {
  const ctx = useContext(PowerSyncReactivityContext)
  if (!ctx) {
    throw new Error('usePowerSyncReactivity must be used within PowerSyncReactivityTestProvider')
  }
  return ctx
}

type PowerSyncReactivityTestProviderProps = {
  children: ReactNode
  tables?: string[]
  queryClient?: QueryClient
  /** Ref to receive triggerChange for use in tests */
  triggerChangeRef?: MutableRefObject<((tables: string[]) => void) | null>
}

/**
 * Wraps children with a triggerable PowerSync mock and QueryClient.
 * Exposes triggerChange via usePowerSyncReactivity() for reactivity tests.
 *
 * @example
 * ```tsx
 * const { result, triggerChange } = renderWithReactivity(<ModelDetailPage />, {
 *   route: '/settings/models/123',
 *   tables: ['models'],
 * })
 * await updateModel('123', { name: 'Updated' })
 * triggerChange(['models'])
 * await waitFor(() => expect(screen.getByText('Updated')).toBeInTheDocument())
 * ```
 */
export const PowerSyncReactivityTestProvider = ({
  children,
  tables = [],
  queryClient: providedQueryClient,
  triggerChangeRef,
}: PowerSyncReactivityTestProviderProps) => {
  const mockRef = useRef<PowerSyncReactivityMock | null>(null)
  if (!mockRef.current) {
    mockRef.current = createPowerSyncMockWithReactivity({ tables })
  }

  const queryClient = useMemo(
    () =>
      providedQueryClient ??
      new QueryClient({
        defaultOptions: {
          queries: { retry: false, gcTime: 0, staleTime: 0 },
        },
      }),
    [providedQueryClient],
  )

  const triggerChange = useCallback((tablesToTrigger: string[]) => {
    mockRef.current?.triggerChange(tablesToTrigger)
  }, [])

  useEffect(() => {
    if (triggerChangeRef) {
      triggerChangeRef.current = triggerChange
      return () => {
        triggerChangeRef.current = null
      }
    }
  }, [triggerChange, triggerChangeRef])

  const value = useMemo(() => ({ triggerChange }), [triggerChange])

  const inner = (
    <PowerSyncReactivityContext.Provider value={value}>
      <PowerSyncContext.Provider value={mockRef.current as never}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </PowerSyncContext.Provider>
    </PowerSyncReactivityContext.Provider>
  )

  if (isDbRegistered()) {
    return <DatabaseProvider db={getDb()}>{inner}</DatabaseProvider>
  }
  return inner
}
