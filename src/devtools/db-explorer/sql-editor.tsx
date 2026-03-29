import { useCallback, useEffect, useRef } from 'react'
import { EditorView, keymap, placeholder as placeholderExt } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { SQLite, sql } from '@codemirror/lang-sql'
import { oneDark } from '@codemirror/theme-one-dark'
import { basicSetup } from 'codemirror'
import { Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTheme } from '@/lib/theme-provider'

type SqlEditorProps = {
  value: string
  onChange: (value: string) => void
  onRun: (sql: string) => void
  isLoading: boolean
  error: string | null
  queryTimeMs: number | null
}

const useIsDarkMode = () => {
  const { theme } = useTheme()
  if (theme === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  }
  return theme === 'dark'
}

export const SqlEditor = ({ value, onChange, onRun, isLoading, error, queryTimeMs }: SqlEditorProps) => {
  const editorRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const isDark = useIsDarkMode()

  // Store latest callbacks in refs to avoid recreating the editor
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onRunRef = useRef(onRun)
  onRunRef.current = onRun

  useEffect(() => {
    if (!editorRef.current) return

    const runKeymap = keymap.of([
      {
        key: 'Mod-Enter',
        run: (view) => {
          onRunRef.current(view.state.doc.toString())
          return true
        },
      },
    ])

    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        sql({ dialect: SQLite }),
        placeholderExt('SELECT * FROM ...'),
        runKeymap,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString())
          }
        }),
        EditorView.theme({
          '&': { fontSize: '13px', maxHeight: '200px' },
          '.cm-scroller': { overflow: 'auto' },
          '.cm-content': { fontFamily: 'ui-monospace, monospace' },
        }),
        ...(isDark ? [oneDark] : []),
      ],
    })

    const view = new EditorView({ state, parent: editorRef.current })
    viewRef.current = view

    return () => {
      view.destroy()
      viewRef.current = null
    }
    // Recreate editor when theme changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDark])

  // Sync external value changes into the editor
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const currentDoc = view.state.doc.toString()
    if (currentDoc !== value) {
      view.dispatch({
        changes: { from: 0, to: currentDoc.length, insert: value },
      })
    }
  }, [value])

  const handleRun = useCallback(() => {
    const currentValue = viewRef.current?.state.doc.toString() ?? value
    onRun(currentValue)
  }, [onRun, value])

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-2">
        <div ref={editorRef} className="border-input bg-background min-w-0 flex-1 overflow-hidden rounded-md border" />
        <Button variant="outline" size="sm" onClick={handleRun} disabled={isLoading} className="shrink-0">
          <Play className="size-3.5" />
          Run
        </Button>
      </div>

      <div className="flex items-center gap-3 text-xs">
        {queryTimeMs != null && <span className="text-muted-foreground">Executed in {queryTimeMs.toFixed(1)}ms</span>}
        {error && <span className="text-destructive">{error}</span>}
        {!error && !queryTimeMs && (
          <span className="text-muted-foreground">
            Press <kbd className="bg-muted rounded px-1 py-0.5 font-mono text-[10px]">Cmd+Enter</kbd> to run
          </span>
        )}
      </div>
    </div>
  )
}
