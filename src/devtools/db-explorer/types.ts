// ---- Adapter interface (DB-agnostic) ----

export type DbObjectType = 'table' | 'view' | 'index' | 'trigger'

export type DbObject = {
  name: string
  type: DbObjectType
  /** The CREATE statement from sqlite_master */
  sqlDefinition: string | null
  /** The table this object belongs to (for indexes and triggers) */
  tblName: string | null
}

export type ColumnInfo = {
  name: string
  type: string
  notnull: boolean
  pk: boolean
  defaultValue: string | null
}

export type QueryResult = {
  columns: string[]
  rows: unknown[][]
}

/**
 * Database adapter for the explorer component.
 * Implement this interface to connect any browser SQLite database.
 */
export type SqliteExplorerAdapter = {
  /** List all tables and views in the database */
  getObjects: () => Promise<DbObject[]>
  /** Get column metadata for a specific table or view */
  getColumns: (objectName: string) => Promise<ColumnInfo[]>
  /** Get total row count for a table or view */
  getRowCount: (objectName: string) => Promise<number>
  /** Execute a SQL query and return columns + rows */
  execute: (sql: string) => Promise<QueryResult>
}

// ---- Component state ----

export type ViewMode = 'query' | 'definition'

export type DbExplorerState = {
  objects: DbObject[]
  selectedObject: string | null
  viewMode: ViewMode
  /** SQL definition shown read-only for indexes/triggers */
  sqlDefinition: string | null
  columns: ColumnInfo[]
  queryResult: QueryResult | null
  customSql: string
  isLoading: boolean
  error: string | null
  page: number
  pageSize: number
  totalRows: number
  queryTimeMs: number | null
}

export type DbExplorerAction =
  | { type: 'SET_OBJECTS'; objects: DbObject[] }
  | { type: 'SELECT_OBJECT'; name: string; columns: ColumnInfo[] }
  | { type: 'SET_DEFINITION_VIEW'; sqlDefinition: string | null }
  | { type: 'SET_QUERY_RESULT'; result: QueryResult; totalRows: number; queryTimeMs: number }
  | { type: 'SET_CUSTOM_SQL'; sql: string }
  | { type: 'SET_LOADING'; loading: boolean }
  | { type: 'SET_ERROR'; error: string }
  | { type: 'SET_PAGE'; page: number }
  | { type: 'SET_PAGE_SIZE'; size: number }
