import { useCallback, useEffect, useState } from 'react'
import { ChevronRight, Eye, List, Table2, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { DbObject, DbObjectType, SqliteExplorerAdapter } from './types'

const objectTypeConfig: Record<DbObjectType, { label: string; icon: typeof Table2 }> = {
  table: { label: 'Tables', icon: Table2 },
  view: { label: 'Views', icon: Eye },
  index: { label: 'Indexes', icon: List },
  trigger: { label: 'Triggers', icon: Zap },
}

const groupOrder: DbObjectType[] = ['table', 'view', 'index', 'trigger']

type ObjectListProps = {
  adapter: SqliteExplorerAdapter
  objects: DbObject[]
  selectedObject: string | null
  onSelect: (name: string) => void
}

export const ObjectList = ({ adapter, objects, selectedObject, onSelect }: ObjectListProps) => {
  const [rowCounts, setRowCounts] = useState<Map<string, number>>(new Map())
  const [expandedGroups, setExpandedGroups] = useState<Set<DbObjectType>>(new Set())

  useEffect(() => {
    const loadCounts = async () => {
      const counts = new Map<string, number>()
      const countable = objects.filter((o) => o.type === 'table' || o.type === 'view')
      for (const obj of countable) {
        try {
          counts.set(obj.name, await adapter.getRowCount(obj.name))
        } catch {
          counts.set(obj.name, -1)
        }
      }
      setRowCounts(counts)
    }
    if (objects.length > 0) {
      loadCounts()
    }
  }, [adapter, objects])

  const toggleGroup = useCallback((type: DbObjectType) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(type)) {
        next.delete(type)
      } else {
        next.add(type)
      }
      return next
    })
  }, [])

  const grouped = groupOrder
    .map((type) => ({
      type,
      ...objectTypeConfig[type],
      items: objects.filter((o) => o.type === type),
    }))
    .filter((g) => g.items.length > 0)

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {grouped.map((group) => {
        const isExpanded = expandedGroups.has(group.type)

        return (
          <div key={group.type} className="flex flex-col">
            <button
              type="button"
              onClick={() => toggleGroup(group.type)}
              className="text-muted-foreground hover:bg-muted/50 flex items-center gap-1 px-3 py-2 text-xs font-semibold uppercase tracking-wider transition-colors"
            >
              <ChevronRight className={cn('size-3 transition-transform', isExpanded && 'rotate-90')} />
              {group.label}
              <span className="ml-auto font-normal">{group.items.length}</span>
            </button>
            {isExpanded &&
              group.items.map((obj) => {
                const count = rowCounts.get(obj.name)
                const isSelected = obj.name === selectedObject
                const Icon = group.icon

                return (
                  <button
                    key={obj.name}
                    type="button"
                    onClick={() => onSelect(obj.name)}
                    className={cn(
                      'flex items-center gap-2 py-1.5 pr-3 pl-7 text-left text-sm transition-colors',
                      'hover:bg-muted/50',
                      isSelected && 'bg-muted font-medium',
                    )}
                  >
                    <Icon className="text-muted-foreground size-3.5 shrink-0" />
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate">{obj.name}</span>
                      {obj.tblName && <span className="text-muted-foreground truncate text-xs">on {obj.tblName}</span>}
                    </div>
                    {count != null && count >= 0 && (
                      <span className="text-muted-foreground ml-auto shrink-0 text-xs">{count}</span>
                    )}
                  </button>
                )
              })}
          </div>
        )
      })}
      {objects.length === 0 && <div className="text-muted-foreground p-4 text-sm">No database objects found</div>}
    </div>
  )
}
