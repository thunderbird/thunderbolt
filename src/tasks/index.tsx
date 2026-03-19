import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/ui/page-header'
import { PageSearch } from '@/components/ui/page-search'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useDatabase } from '@/contexts'
import { createTask, deleteTask, getIncompleteTasks, getIncompleteTasksCount, updateTask } from '@/dal'
import { trackEvent } from '@/lib/posthog'
import { cn } from '@/lib/utils'
import type { Task } from '@/types'
import type { DropAnimation } from '@dnd-kit/core'
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useMutation } from '@tanstack/react-query'
import { useQuery } from '@powersync/tanstack-react-query'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { CheckCircle2, GripVertical, Plus, Square } from 'lucide-react'
import { type KeyboardEvent, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { v7 as uuidv7 } from 'uuid'

// Task Item Component - Memoized for performance
type TaskItemProps = {
  task: Task
  isCompleting: boolean
  onComplete: (id: string) => void
  onEdit: (id: string, value: string) => void
  onDelete: (id: string) => void
}

const TaskItem = memo(({ task, isCompleting, onComplete, onEdit, onDelete }: TaskItemProps) => {
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState(task.item)
  const inputRef = useRef<HTMLInputElement>(null)

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    disabled: isEditing || isCompleting,
  })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition: transition ? transition.replace(/transform \d+ms/, 'transform 20ms') : undefined,
  }

  const handleStartEdit = useCallback(() => {
    setIsEditing(true)
    setEditValue(task.item)
    // Focus will be handled by useEffect
  }, [task.item])

  const handleSaveEdit = useCallback(() => {
    const trimmed = editValue.trim()
    if (trimmed && trimmed !== task.item) {
      onEdit(task.id, trimmed)
    } else if (!trimmed) {
      onDelete(task.id)
    }
    setIsEditing(false)
  }, [editValue, task.id, task.item, onEdit, onDelete])

  const handleCancelEdit = useCallback(() => {
    setEditValue(task.item)
    setIsEditing(false)
  }, [task.item])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        handleSaveEdit()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        handleCancelEdit()
      }
    },
    [handleSaveEdit, handleCancelEdit],
  )

  // Focus input when editing starts
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  return (
    <div
      ref={setNodeRef}
      style={{
        ...style,
        opacity: isCompleting ? 0 : isDragging ? 0.5 : 1,
        transition: isCompleting
          ? 'opacity 1s ease-out'
          : isDragging
            ? 'opacity 0.2s ease'
            : style.transition || 'transform 20ms ease-out',
      }}
      className={cn(
        'group flex items-center gap-3 rounded-lg bg-background px-3 py-2',
        'hover:bg-muted/50 transition-colors',
        isDragging && 'shadow-lg',
      )}
    >
      <button
        className={cn(
          'touch-none p-1 text-muted-foreground',
          'hover:text-foreground transition-colors',
          'cursor-grab active:cursor-grabbing',
          (isEditing || isCompleting) && 'opacity-50 cursor-not-allowed',
        )}
        {...attributes}
        {...listeners}
        disabled={isEditing || isCompleting}
      >
        <GripVertical className="h-4 w-4" />
      </button>

      <div className="flex-1 min-w-0">
        {isEditing ? (
          <input
            ref={inputRef}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={handleSaveEdit}
            onKeyDown={handleKeyDown}
            className={cn(
              'w-full bg-transparent text-sm leading-5',
              'border-0 border-b border-primary',
              'p-0 m-0',
              'focus:outline-none focus:ring-0',
              'placeholder:text-muted-foreground',
            )}
            style={{ height: '20px' }} // Match button height exactly
          />
        ) : (
          <button
            onClick={handleStartEdit}
            disabled={isCompleting}
            className={cn(
              'w-full text-left text-sm leading-5',
              'p-0 m-0',
              'transition-all duration-300',
              isCompleting && 'line-through text-muted-foreground',
            )}
            style={{ height: '20px' }} // Explicit height
          >
            {task.item}
          </button>
        )}
      </div>

      <button
        onClick={() => onComplete(task.id)}
        disabled={isEditing}
        className={cn(
          'p-1 transition-colors',
          'hover:text-primary',
          isCompleting && 'text-primary',
          isEditing && 'opacity-50 cursor-not-allowed',
        )}
      >
        {isCompleting ? <CheckCircle2 className="h-5 w-5" /> : <Square className="h-5 w-5" />}
      </button>
    </div>
  )
})

TaskItem.displayName = 'TaskItem'

// New Task Input Component
type NewTaskInputProps = {
  onAdd: (value: string) => void
  onCancel: () => void
}

const NewTaskInput = ({ onAdd, onCancel }: NewTaskInputProps) => {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleSubmit = () => {
    const trimmed = value.trim()
    if (trimmed) {
      onAdd(trimmed)
      setValue('')
    } else {
      onCancel()
    }
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSubmit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }

  return (
    <div className="flex items-center gap-3 rounded-lg bg-background px-3 py-2 hover:bg-muted/50">
      <div className="w-6 h-6 p-1" /> {/* Spacer for drag handle */}
      <div className="flex-1 min-w-0">
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={handleSubmit}
          onKeyDown={handleKeyDown}
          placeholder="Add a new task..."
          className="w-full bg-transparent text-sm leading-5 p-0 m-0 focus:outline-none"
          style={{ height: '20px' }}
        />
      </div>
      <div className="p-1">
        <Square className="h-5 w-5 text-muted-foreground" />
      </div>
    </div>
  )
}

// Main Tasks Page Component
export default function TasksPage() {
  const db = useDatabase()

  // State
  const [isAddingNew, setIsAddingNew] = useState(false)
  const [completingTasks, setCompletingTasks] = useState<Set<string>>(new Set())
  const [activeId, setActiveId] = useState<string | null>(null)
  const [optimisticOrder, setOptimisticOrder] = useState<string[]>([])

  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('')

  const handleSearch = (value: string) => {
    setDebouncedSearchQuery(value)
    if (value.trim()) {
      trackEvent('task_search', { query_length: value.length })
    }
  }

  // Drag and drop sensors
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  )

  // Faster drop animation configuration for DragOverlay
  const dropAnimation: DropAnimation = {
    duration: 80, // nearly instant
    easing: 'ease-out',
  }

  // Fetch tasks via PowerSync for reactive/live updates
  const {
    data: tasks = [],
    isLoading,
    isPlaceholderData,
  } = useQuery({
    queryKey: ['tasks', debouncedSearchQuery],
    query: toCompilableQuery(getIncompleteTasks(db, debouncedSearchQuery)),
    placeholderData: (previousData) => previousData,
  })

  // Reset optimistic order when tasks change significantly
  useEffect(() => {
    // Only reset if we're not dragging and the task count changed
    if (!activeId && optimisticOrder.length !== tasks.length) {
      setOptimisticOrder([])
    }
  }, [tasks.length, activeId, optimisticOrder.length])

  // Create ordered tasks
  const orderedTasks = useMemo(() => {
    // If we have an optimistic order and it matches the task count, use it
    if (optimisticOrder.length > 0 && optimisticOrder.length === tasks.length) {
      const taskMap = new Map(tasks.map((t) => [t.id, t]))
      return optimisticOrder.map((id) => taskMap.get(id)).filter((t): t is Task => t !== undefined)
    }
    // Otherwise, use the original task order
    return tasks
  }, [tasks, optimisticOrder])

  // Count total tasks (query returns [{ count }])
  const { data: countResult } = useQuery({
    queryKey: ['tasks', 'count'],
    query: toCompilableQuery(getIncompleteTasksCount(db)),
  })
  const totalCount = countResult?.[0]?.count ?? 0

  // Mutations
  const addTaskMutation = useMutation({
    mutationFn: async (item: string) => {
      const order = tasks.length > 0 ? Math.min(...tasks.map((t) => t.order)) - 100 : 1000

      await createTask(db, {
        id: uuidv7(),
        item,
        order,
        isComplete: 0,
      })
    },
    onSuccess: (_, item) => {
      trackEvent('task_add', { task_length: item.length })
    },
  })

  const updateTaskMutation = useMutation({
    mutationFn: async ({ id, item }: { id: string; item: string }) => {
      await updateTask(db, id, { item })
    },
    onSuccess: (_, values) => {
      trackEvent('task_update_text', { task_id: values.id, new_length: values.item.length })
    },
  })

  const deleteTaskMutation = useMutation({
    mutationFn: (id: string) => deleteTask(db, id),
  })

  const updateOrderMutation = useMutation({
    mutationFn: async (updates: { id: string; order: number }[]) => {
      await Promise.all(updates.map(({ id, order }) => updateTask(db, id, { order })))
    },
    onSuccess: (_, updates) => {
      trackEvent('task_reorder', {
        moved_task_id: updates[0].id,
        total_tasks: updates.length,
      })
    },
  })

  const completeTaskMutation = useMutation({
    mutationFn: async (id: string) => {
      await updateTask(db, id, { isComplete: 1 })
    },
    onSuccess: (_, id) => {
      trackEvent('task_mark_complete', { task_id: id })
    },
  })

  // Handlers
  const handleAddTask = useCallback(
    (item: string) => {
      addTaskMutation.mutate(item)
      setIsAddingNew(false)
    },
    [addTaskMutation],
  )

  const handleEditTask = useCallback(
    (id: string, item: string) => {
      updateTaskMutation.mutate({ id, item })
    },
    [updateTaskMutation],
  )

  const handleDeleteTask = useCallback(
    (id: string) => {
      deleteTaskMutation.mutate(id)
    },
    [deleteTaskMutation],
  )

  const handleCompleteTask = useCallback(
    (id: string) => {
      setCompletingTasks((prev) => new Set(prev).add(id))

      setTimeout(() => {
        completeTaskMutation.mutate(id)
        setCompletingTasks((prev) => {
          const newSet = new Set(prev)
          newSet.delete(id)
          return newSet
        })
      }, 1000)
    },
    [completeTaskMutation],
  )

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(event.active.id as string)
  }, [])

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event

      if (over && active.id !== over.id) {
        // Use current tasks order if optimistic order is empty
        const currentOrder = optimisticOrder.length > 0 ? optimisticOrder : tasks.map((t) => t.id)
        const oldIndex = currentOrder.indexOf(active.id as string)
        const newIndex = currentOrder.indexOf(over.id as string)

        if (oldIndex !== -1 && newIndex !== -1) {
          const newOrder = arrayMove(currentOrder, oldIndex, newIndex)
          setOptimisticOrder(newOrder)

          // Calculate order updates
          const updates: { id: string; order: number }[] = []
          const taskMap = new Map(tasks.map((t) => [t.id, t]))

          for (let i = Math.min(oldIndex, newIndex); i <= Math.max(oldIndex, newIndex); i++) {
            const taskId = newOrder[i]
            const task = taskMap.get(taskId)
            if (!task) {
              continue
            }

            let order: number
            if (i === 0) {
              const next = taskMap.get(newOrder[1])
              order = next ? next.order - 100 : 0
            } else if (i === newOrder.length - 1) {
              const prev = taskMap.get(newOrder[i - 1])
              order = prev ? prev.order + 100 : 1000
            } else {
              const prev = taskMap.get(newOrder[i - 1])
              const next = taskMap.get(newOrder[i + 1])
              order = prev && next ? (prev.order + next.order) / 2 : i * 100
            }

            updates.push({ id: taskId, order })
          }

          if (updates.length > 0) {
            updateOrderMutation.mutate(updates)
          }
        }
      }

      setActiveId(null)
    },
    [optimisticOrder, tasks, updateOrderMutation],
  )

  const activeTask = useMemo(() => tasks.find((t) => t.id === activeId), [tasks, activeId])

  // Check if we should show empty state
  const showEmptyState = !isLoading && !isPlaceholderData && totalCount === 0 && !debouncedSearchQuery && !isAddingNew

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex-1 overflow-y-auto">
        <div className="flex flex-col gap-6 p-4 w-full max-w-[1200px] mx-auto">
          <PageSearch onSearch={handleSearch}>
            <PageHeader title="Tasks">
              {!showEmptyState && (
                <>
                  <PageSearch.Button tooltip="Search" />
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="outline"
                          size="icon"
                          className="rounded-lg"
                          onClick={() => setIsAddingNew(true)}
                          disabled={isAddingNew}
                        >
                          <Plus className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>Add Task</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </>
              )}
            </PageHeader>

            <PageSearch.Input placeholder="Search tasks..." onSearch={handleSearch} />
          </PageSearch>

          {showEmptyState ? (
            <div className="flex items-center justify-center p-16">
              <div className="text-center max-w-sm">
                <div className="bg-primary/10 p-4 rounded-full mb-4 inline-block">
                  <CheckCircle2 className="h-12 w-12 text-primary" />
                </div>
                <h3 className="text-xl font-semibold mb-6">No tasks yet</h3>
                <Button onClick={() => setIsAddingNew(true)} className="gap-2">
                  <Plus className="h-4 w-4" />
                  Add Your First Task
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {isLoading ? (
                <div className="space-y-2">
                  {[...Array(5)].map((_, i) => (
                    <div key={i} className="flex items-center gap-3 p-3">
                      <Skeleton className="h-5 w-5 rounded" />
                      <Skeleton className="h-5 flex-1" />
                      <Skeleton className="h-5 w-5 rounded" />
                    </div>
                  ))}
                </div>
              ) : (
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragStart={handleDragStart}
                  onDragEnd={handleDragEnd}
                >
                  <SortableContext items={orderedTasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
                    <div className="space-y-2">
                      {isAddingNew && <NewTaskInput onAdd={handleAddTask} onCancel={() => setIsAddingNew(false)} />}

                      {orderedTasks.map((task) => (
                        <TaskItem
                          key={task.id}
                          task={task}
                          isCompleting={completingTasks.has(task.id)}
                          onComplete={handleCompleteTask}
                          onEdit={handleEditTask}
                          onDelete={handleDeleteTask}
                        />
                      ))}

                      {tasks.length === 0 && debouncedSearchQuery && (
                        <div className="text-center py-12 text-muted-foreground">
                          No tasks found matching "{debouncedSearchQuery}"
                        </div>
                      )}

                      {totalCount > 50 && (
                        <div className="text-center py-4 text-sm text-muted-foreground">
                          Showing 50 of {totalCount} tasks
                        </div>
                      )}
                    </div>
                  </SortableContext>

                  <DragOverlay dropAnimation={dropAnimation}>
                    {activeTask && (
                      <div className="flex items-center gap-3 rounded-lg bg-background px-3 py-2 shadow-lg border">
                        <GripVertical className="h-4 w-4 text-muted-foreground" />
                        <span className="flex-1 text-sm">{activeTask.item}</span>
                        <Square className="h-5 w-5 text-muted-foreground" />
                      </div>
                    )}
                  </DragOverlay>
                </DndContext>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
