import { Code2, Loader2, MoreHorizontal, Network, SquareTerminal } from 'lucide-react'
import type { Crew } from '@shared/types'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { iconBtn } from './pill'

interface Props {
  crew: Crew
  indexed: boolean
  indexing: boolean
  onIndex: () => void
  onIde: () => void
  onShell: () => void
  onEdit: () => void
  onDelete: () => void
}

function Mini({ label, children, ...rest }: { label: string; children: React.ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className={iconBtn} aria-label={label} {...rest}>
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

// The open project: its name over its folder, two separate lines. Hovering (or focusing) it slides the mini buttons in
// over the right end of the block, so nothing around it moves.
export function ProjectBlock({ crew, indexed, indexing, onIndex, onIde, onShell, onEdit, onDelete }: Props) {
  return (
    <div className="group/proj relative flex min-w-[140px] max-w-[220px] shrink-0 flex-col justify-center leading-tight">
      <h1 className="w-fit max-w-full truncate text-[13px] font-semibold" title={crew.name}>
        {crew.name}
      </h1>
      <div className="text-muted-foreground w-0 min-w-full truncate font-mono text-[10.5px]" title={crew.folder}>
        {crew.folder}
      </div>
      <div className="bg-background/95 pointer-events-none absolute inset-y-0 right-0 flex items-center rounded-md pl-1 opacity-0 shadow-[-8px_0_8px_var(--color-background)] transition-opacity duration-150 group-focus-within/proj:pointer-events-auto group-focus-within/proj:opacity-100 group-hover/proj:pointer-events-auto group-hover/proj:opacity-100">
        <Mini label={indexed ? 'Update index' : 'Index with CodeGraph'} onClick={onIndex} disabled={indexing}>
          {indexing ? <Loader2 className="animate-spin" /> : <Network />}
        </Mini>
        <Mini label={`Open ${crew.name} in IDE`} onClick={onIde}>
          <Code2 />
        </Mini>
        <Mini label={`New shell in ${crew.name}`} onClick={onShell}>
          <SquareTerminal />
        </Mini>
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <button type="button" className={iconBtn} aria-label={`Actions for project ${crew.name}`}>
                  <MoreHorizontal />
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>Project actions</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={onEdit}>Edit project</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onDelete}>
              Delete project
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
