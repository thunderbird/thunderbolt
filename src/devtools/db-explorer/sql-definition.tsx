import { useEffect, useRef } from 'react'
import { EditorView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { SQLite, sql } from '@codemirror/lang-sql'
import { oneDark } from '@codemirror/theme-one-dark'
import { basicSetup } from 'codemirror'
import { useTheme } from '@/lib/theme-provider'

type SqlDefinitionProps = {
  value: string
}

const useIsDarkMode = () => {
  const { theme } = useTheme()
  if (theme === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  }
  return theme === 'dark'
}

export const SqlDefinition = ({ value }: SqlDefinitionProps) => {
  const editorRef = useRef<HTMLDivElement>(null)
  const isDark = useIsDarkMode()

  useEffect(() => {
    if (!editorRef.current) return

    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        sql({ dialect: SQLite }),
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        EditorView.theme({
          '&': { fontSize: '13px' },
          '.cm-scroller': { overflow: 'auto' },
          '.cm-content': { fontFamily: 'ui-monospace, monospace' },
          '.cm-cursor': { display: 'none' },
        }),
        ...(isDark ? [oneDark] : []),
      ],
    })

    const view = new EditorView({ state, parent: editorRef.current })

    return () => {
      view.destroy()
    }
  }, [value, isDark])

  return (
    <div className="flex h-full flex-col overflow-hidden p-3">
      <div ref={editorRef} className="border-input bg-background flex-1 overflow-hidden rounded-md border" />
    </div>
  )
}
