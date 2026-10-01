import { useState } from 'react'
import { MoreHorizontal, Plus } from 'lucide-react'
import type { SquadWithOperators } from '@shared/types'
import { DeleteSquadDialog, EditSquadDialog } from '@/components/dashboard/Dialogs'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

type Open = 'edit' | 'delete' | null

// Squad heading shared by the cards and the list: name, running count, add operator, edit and delete.
export function SquadHeader({ squad, onAddOperator }: { squad: SquadWithOperators; onAddOperator: () => void }) {
  const [open, setOpen] = useState<Open>(null)
  return (
    <div className="mb-2.5 flex items-center gap-2">
      <h3 className="text-sm font-medium">{squad.name}</h3>
      <span className="text-muted-foreground text-xs tabular-nums">
        {squad.operators.filter((s) => s.status === 'running').length}/{squad.operators.length} running
      </span>
      <div className="bg-border ml-2 h-px flex-1" />
      <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onAddOperator}>
        <Plus className="size-3.5" /> Operator
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-7" aria-label={`Actions for squad ${squad.name}`}>
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setOpen('edit')}>Rename squad</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setOpen('delete')}>
            Delete squad
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {open === 'edit' && <EditSquadDialog squad={squad} open onOpenChange={(o) => !o && setOpen(null)} />}
      {open === 'delete' && <DeleteSquadDialog squad={squad} operators={squad.operators} open onOpenChange={(o) => !o && setOpen(null)} />}
    </div>
  )
}
