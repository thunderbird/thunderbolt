import { useDualWebview, type DualWebviewConfig } from '@/hooks/use-dual-webview'
import { useEffect, useRef, useState } from 'react'

export type { DualWebviewConfig }

type DualWebviewContainerProps = {
  config: DualWebviewConfig
  showSplitter?: boolean
}

/**
 * Container component for dual side-by-side webviews with optional draggable splitter
 */
export const DualWebviewContainer = ({ config, showSplitter = true }: DualWebviewContainerProps) => {
  const { isInitialized, splitRatio, updateSplitRatio } = useDualWebview(config)
  const [isDragging, setIsDragging] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Handle splitter drag
  useEffect(() => {
    if (!showSplitter || !isDragging) return

    const handleMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return

      const containerRect = containerRef.current.getBoundingClientRect()
      const relativeX = e.clientX - containerRect.left
      const newRatio = relativeX / containerRect.width

      // Constrain ratio between 10% and 90%
      const constrainedRatio = Math.max(0.1, Math.min(0.9, newRatio))
      updateSplitRatio(constrainedRatio)
    }

    const handleMouseUp = () => {
      setIsDragging(false)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging, showSplitter, updateSplitRatio])

  const handleSplitterMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }

  return (
    <div ref={containerRef} className="relative w-full h-full overflow-hidden">
      {/* Main content - webviews will overlay this */}
      <div className="w-full h-full flex items-center justify-center bg-background">
        {!isInitialized ? (
          <div className="text-muted-foreground">Initializing webviews...</div>
        ) : (
          <div className="text-muted-foreground text-sm">
            Dual webview active (split: {Math.round(splitRatio * 100)}% / {Math.round((1 - splitRatio) * 100)}%)
          </div>
        )}
      </div>

      {/* Visual splitter indicator */}
      {showSplitter && isInitialized && (
        <div
          className="absolute top-0 bottom-0 w-1 bg-border hover:bg-primary cursor-col-resize z-50"
          style={{ left: `${splitRatio * 100}%` }}
          onMouseDown={handleSplitterMouseDown}
        >
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-12 bg-background border border-border rounded-md flex items-center justify-center shadow-md pointer-events-none">
            <div className="flex gap-0.5">
              <div className="w-0.5 h-4 bg-muted-foreground" />
              <div className="w-0.5 h-4 bg-muted-foreground" />
            </div>
          </div>
        </div>
      )}

      {/* Cursor overlay during drag */}
      {isDragging && <div className="absolute inset-0 cursor-col-resize z-40" />}
    </div>
  )
}
