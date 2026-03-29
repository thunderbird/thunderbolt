import { useCallback, useEffect, useReducer } from 'react'
import type { DbExplorerAction, DbExplorerState, SqliteExplorerAdapter } from './types'

const DEFAULT_PAGE_SIZE = 50

const initialState: DbExplorerState = {
  objects: [],
  selectedObject: null,
  viewMode: 'query',
  sqlDefinition: null,
  columns: [],
  queryResult: null,
  customSql: '',
  isLoading: false,
  error: null,
  page: 0,
  pageSize: DEFAULT_PAGE_SIZE,
  totalRows: 0,
  queryTimeMs: null,
}

const reducer = (state: DbExplorerState, action: DbExplorerAction): DbExplorerState => {
  switch (action.type) {
    case 'SET_OBJECTS':
      return { ...state, objects: action.objects }
    case 'SELECT_OBJECT':
      return {
        ...state,
        selectedObject: action.name,
        columns: action.columns,
        viewMode: 'query',
        sqlDefinition: null,
        page: 0,
        queryResult: null,
        error: null,
        queryTimeMs: null,
      }
    case 'SET_DEFINITION_VIEW':
      return {
        ...state,
        viewMode: 'definition',
        sqlDefinition: action.sqlDefinition,
        queryResult: null,
        error: null,
        queryTimeMs: null,
      }
    case 'SET_QUERY_RESULT':
      return {
        ...state,
        queryResult: action.result,
        totalRows: action.totalRows,
        queryTimeMs: action.queryTimeMs,
        isLoading: false,
        error: null,
      }
    case 'SET_CUSTOM_SQL':
      return { ...state, customSql: action.sql }
    case 'SET_LOADING':
      return { ...state, isLoading: action.loading, error: action.loading ? null : state.error }
    case 'SET_ERROR':
      return { ...state, error: action.error, isLoading: false, queryResult: null, queryTimeMs: null }
    case 'SET_PAGE':
      return { ...state, page: action.page }
    case 'SET_PAGE_SIZE':
      return { ...state, pageSize: action.size, page: 0 }
  }
}

export const useDbExplorerState = (adapter: SqliteExplorerAdapter) => {
  const [state, dispatch] = useReducer(reducer, initialState)

  // Load table/view list on mount
  useEffect(() => {
    const load = async () => {
      try {
        const objects = await adapter.getObjects()
        console.log('[db-explorer] loaded objects:', objects)
        dispatch({ type: 'SET_OBJECTS', objects })
      } catch (err) {
        console.error('[db-explorer] failed to load objects:', err)
        dispatch({ type: 'SET_ERROR', error: String(err) })
      }
    }
    load()
  }, [adapter])

  const selectObject = useCallback(
    async (name: string) => {
      const obj = state.objects.find((o) => o.name === name)
      const objectType = obj?.type ?? 'table'

      try {
        if (objectType === 'index' || objectType === 'trigger') {
          // For indexes and triggers: show SQL definition read-only, no table/execution
          dispatch({ type: 'SELECT_OBJECT', name, columns: [] })
          dispatch({ type: 'SET_DEFINITION_VIEW', sqlDefinition: obj?.sqlDefinition ?? null })
          return
        }

        // Tables and views: fetch columns + paginated data
        const columns = await adapter.getColumns(name)
        dispatch({ type: 'SELECT_OBJECT', name, columns })
        dispatch({ type: 'SET_CUSTOM_SQL', sql: `SELECT * FROM "${name}"` })

        dispatch({ type: 'SET_LOADING', loading: true })
        const start = performance.now()

        const [result, totalRows] = await Promise.all([
          adapter.execute(`SELECT * FROM "${name}" LIMIT ${DEFAULT_PAGE_SIZE} OFFSET 0`),
          adapter.getRowCount(name),
        ])

        dispatch({
          type: 'SET_QUERY_RESULT',
          result,
          totalRows,
          queryTimeMs: performance.now() - start,
        })
      } catch (err) {
        dispatch({ type: 'SET_ERROR', error: String(err) })
      }
    },
    [adapter, state.objects],
  )

  const runQuery = useCallback(
    async (query: string) => {
      dispatch({ type: 'SET_LOADING', loading: true })
      try {
        const start = performance.now()
        const result = await adapter.execute(query)
        dispatch({
          type: 'SET_QUERY_RESULT',
          result,
          totalRows: result.rows.length,
          queryTimeMs: performance.now() - start,
        })
      } catch (err) {
        dispatch({ type: 'SET_ERROR', error: String(err) })
      }
    },
    [adapter],
  )

  const fetchPage = useCallback(
    async (page: number) => {
      if (!state.selectedObject) return
      dispatch({ type: 'SET_PAGE', page })
      dispatch({ type: 'SET_LOADING', loading: true })

      try {
        const start = performance.now()
        const offset = page * state.pageSize
        const result = await adapter.execute(
          `SELECT * FROM "${state.selectedObject}" LIMIT ${state.pageSize} OFFSET ${offset}`,
        )
        dispatch({
          type: 'SET_QUERY_RESULT',
          result,
          totalRows: state.totalRows,
          queryTimeMs: performance.now() - start,
        })
      } catch (err) {
        dispatch({ type: 'SET_ERROR', error: String(err) })
      }
    },
    [adapter, state.selectedObject, state.pageSize, state.totalRows],
  )

  const setPageSize = useCallback(
    (size: number) => {
      dispatch({ type: 'SET_PAGE_SIZE', size })
      if (state.selectedObject) {
        // Re-fetch with new page size from page 0
        const run = async () => {
          dispatch({ type: 'SET_LOADING', loading: true })
          try {
            const start = performance.now()
            const result = await adapter.execute(`SELECT * FROM "${state.selectedObject}" LIMIT ${size} OFFSET 0`)
            dispatch({
              type: 'SET_QUERY_RESULT',
              result,
              totalRows: state.totalRows,
              queryTimeMs: performance.now() - start,
            })
          } catch (err) {
            dispatch({ type: 'SET_ERROR', error: String(err) })
          }
        }
        run()
      }
    },
    [adapter, state.selectedObject, state.totalRows],
  )

  const setCustomSql = useCallback((sql: string) => {
    dispatch({ type: 'SET_CUSTOM_SQL', sql })
  }, [])

  return {
    state,
    selectObject,
    runQuery,
    fetchPage,
    setPageSize,
    setCustomSql,
  }
}
