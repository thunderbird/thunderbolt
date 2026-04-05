import { useCallback, useState } from 'react'
import { Check, ChevronLeft, ChevronRight, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { useColumnResize } from './use-column-resize'
import type { QueryResult } from './types'

type DataTableProps = {
  result: QueryResult | null
  isLoading: boolean
  page: number
  pageSize: number
  totalRows: number
  onPageChange: (page: number) => void
  onPageSizeChange: (size: number) => void
}

const pageSizes = [25, 50, 100, 200]

const formatCellValue = (value: unknown): string => {
  if (value === null || value === undefined) {
    return 'NULL'
  }
  if (typeof value === 'object') {
    return JSON.stringify(value)
  }
  return String(value)
}

export const DataTable = ({
  result,
  isLoading,
  page,
  pageSize,
  totalRows,
  onPageChange,
  onPageSizeChange,
}: DataTableProps) => {
  const columnCount = result?.columns.length ?? 0
  const { getColumnWidth, onMouseDown, totalWidth } = useColumnResize(columnCount)
  const [copiedCell, setCopiedCell] = useState<string | null>(null)

  const handleCopy = useCallback(async (value: string, cellKey: string) => {
    await navigator.clipboard.writeText(value)
    setCopiedCell(cellKey)
    setTimeout(() => setCopiedCell(null), 1500)
  }, [])

  if (!result) {
    return (
      <div className="text-muted-foreground flex flex-1 items-center justify-center text-sm">
        Select a table or run a query to see results
      </div>
    )
  }

  const totalPages = Math.ceil(totalRows / pageSize)
  const hasNextPage = page < totalPages - 1
  const hasPrevPage = page > 0

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Table with horizontal scroll */}
      <div className="flex-1 overflow-auto">
        <table className="border-collapse" style={{ width: Math.max(totalWidth, 100), tableLayout: 'fixed' }}>
          <colgroup>
            {result.columns.map((_, i) => (
              <col key={i} style={{ width: getColumnWidth(i) }} />
            ))}
          </colgroup>
          <thead className="bg-muted/50 sticky top-0">
            <tr className="border-b">
              {result.columns.map((col, i) => (
                <th
                  key={i}
                  className="text-muted-foreground relative select-none truncate border-r px-2 py-1.5 text-left text-xs font-medium"
                >
                  {col}
                  <div
                    className="absolute top-0 right-0 bottom-0 w-1.5 cursor-col-resize hover:bg-primary/30"
                    onMouseDown={(e) => onMouseDown(e, i)}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={columnCount} className="text-muted-foreground px-2 py-8 text-center text-sm">
                  Loading...
                </td>
              </tr>
            ) : result.rows.length === 0 ? (
              <tr>
                <td colSpan={columnCount} className="text-muted-foreground px-2 py-8 text-center text-sm">
                  No rows
                </td>
              </tr>
            ) : (
              result.rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="hover:bg-muted/30 border-b transition-colors">
                  {(row as unknown[]).map((cell, colIndex) => {
                    const cellValue = formatCellValue(cell)
                    const cellKey = `${rowIndex}-${colIndex}`
                    const isCopied = copiedCell === cellKey
                    const isNull = cell === null || cell === undefined

                    return (
                      <td
                        key={colIndex}
                        className={cn(
                          'group relative cursor-pointer truncate border-r px-2 py-1 font-mono text-xs',
                          isNull && 'text-muted-foreground italic',
                        )}
                        title={cellValue}
                        onClick={() => handleCopy(cellValue, cellKey)}
                      >
                        {cellValue}
                        <span
                          className={cn(
                            'absolute top-1/2 right-1 -translate-y-1/2 opacity-0 transition-opacity',
                            isCopied ? 'opacity-100' : 'group-hover:opacity-60',
                          )}
                        >
                          {isCopied ? <Check className="text-green-500 size-3" /> : <Copy className="size-3" />}
                        </span>
                      </td>
                    )
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="border-t bg-muted/30 flex items-center justify-between px-3 py-2">
        <div className="text-muted-foreground text-xs">
          {totalRows} row{totalRows !== 1 ? 's' : ''}
          {totalPages > 1 && (
            <span>
              {' '}
              &middot; Page {page + 1} of {totalPages}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Select value={String(pageSize)} onValueChange={(v) => onPageSizeChange(Number(v))}>
            <SelectTrigger size="sm" className="h-7 w-auto gap-1 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {pageSizes.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size} rows
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="size-7 p-0"
              disabled={!hasPrevPage}
              onClick={() => onPageChange(page - 1)}
            >
              <ChevronLeft className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="size-7 p-0"
              disabled={!hasNextPage}
              onClick={() => onPageChange(page + 1)}
            >
              <ChevronRight className="size-3.5" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
