import { type MouseEvent as ReactMouseEvent, useCallback, useRef, useState } from 'react'

const minColumnWidth = 60
const defaultColumnWidth = 150

export const useColumnResize = (columnCount: number) => {
  const [columnWidths, setColumnWidths] = useState<Map<number, number>>(new Map())
  const dragState = useRef<{ columnIndex: number; startX: number; startWidth: number } | null>(null)

  const getColumnWidth = useCallback((index: number) => columnWidths.get(index) ?? defaultColumnWidth, [columnWidths])

  const onMouseDown = useCallback(
    (e: ReactMouseEvent, columnIndex: number) => {
      e.preventDefault()
      const startWidth = columnWidths.get(columnIndex) ?? defaultColumnWidth
      dragState.current = { columnIndex, startX: e.clientX, startWidth }

      const onMouseMove = (moveEvent: MouseEvent) => {
        if (!dragState.current) {
          return
        }
        const delta = moveEvent.clientX - dragState.current.startX
        const newWidth = Math.max(minColumnWidth, dragState.current.startWidth + delta)
        setColumnWidths((prev) => new Map(prev).set(dragState.current!.columnIndex, newWidth))
      }

      const onMouseUp = () => {
        dragState.current = null
        document.removeEventListener('mousemove', onMouseMove)
        document.removeEventListener('mouseup', onMouseUp)
      }

      document.addEventListener('mousemove', onMouseMove)
      document.addEventListener('mouseup', onMouseUp)
    },
    [columnWidths],
  )

  const resetWidths = useCallback(() => {
    setColumnWidths(new Map())
  }, [])

  const totalWidth = Array.from({ length: columnCount }, (_, i) => getColumnWidth(i)).reduce((sum, w) => sum + w, 0)

  return { getColumnWidth, onMouseDown, resetWidths, totalWidth }
}
