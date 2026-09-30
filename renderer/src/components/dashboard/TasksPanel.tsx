import { useState, type FormEvent } from 'react'
import { MoreHorizontal, Plus } from 'lucide-react'
import type { Operator, Task, TaskState } from '@shared/types'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { useAction } from '@/lib/queries'

const COLUMNS: Array<{ state: TaskState; label: string }> = [
  { state: 'doing', label: 'Doing' },
  { state: 'review', label: 'Review' },
  { state: 'todo', label: 'To do' },
  { state: 'done', label: 'Done' },
]

export function TasksPanel({ crewId, tasks, operators }: { crewId: number; tasks: Task[]; operators: Operator[] }) {
  const [title, setTitle] = useState('')
  const create = useAction('tasks:create')

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return
    create.mutate([{ crewId, title }], { onSuccess: () => setTitle('') })
  }

  return (
    <div className="space-y-4 p-3">
      <form onSubmit={submit} className="flex gap-2">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a task…" className="h-8" />
        <Button size="icon" className="size-8 shrink-0" type="submit" aria-label="Add task">
          <Plus />
        </Button>
      </form>

      {COLUMNS.map(({ state, label }) => {
        const list = tasks.filter((t) => t.state === state)
        if (list.length === 0 && state === 'done') return null
        return (
          <div key={state}>
            <div className="text-muted-foreground mb-1.5 flex items-center gap-2 text-[11px] font-medium tracking-wider uppercase">
              {label} <span className="tabular-nums">{list.length}</span>
            </div>
            <div className="space-y-1">
              {list.map((t) => (
                <TaskRow key={t.id} task={t} operators={operators} />
              ))}
              {list.length === 0 && <div className="text-muted-foreground/60 px-2 text-xs">—</div>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function TaskRow({ task, operators }: { task: Task; operators: Operator[] }) {
  const move = useAction('tasks:move')
  const operator = operators.find((s) => s.id === task.operatorId)
  return (
    <div className="bg-card group flex items-center gap-2 rounded-md border px-2.5 py-1.5">
      <div className="min-w-0 flex-1">
        <div className={task.state === 'done' ? 'text-muted-foreground truncate text-xs line-through' : 'truncate text-xs'}>
          {task.title}
        </div>
        {operator && <div className="text-muted-foreground truncate font-mono text-[10px]">{operator.role}</div>}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-6 opacity-60 group-hover:opacity-100" aria-label="Move task">
            <MoreHorizontal className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel className="text-xs">Move to</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {COLUMNS.filter((c) => c.state !== task.state).map((c) => (
            <DropdownMenuItem key={c.state} onSelect={() => move.mutate([task.id, c.state])}>
              {c.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
