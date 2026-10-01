import { memo } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { Network, SquareTerminal, User, Users } from 'lucide-react'
import type { GraphNodeType, OperatorStatus } from '@shared/types'
import { StatusDot } from '@/components/dashboard/StatusDot'
import { statusLabel } from '@/lib/format'
import { cn } from '@/lib/utils'

export interface GraphNodeData extends Record<string, unknown> {
  kind: GraphNodeType
  label: string
  status?: OperatorStatus
  // 'Claude Code - sonnet', shown under an operator's name.
  agent?: string
  unread: number
  // Title of the job the operator is working on.
  job?: string
}

export type FlowNode = Node<GraphNodeData, GraphNodeType>

const handleClass = '!size-2.5 !border-2'

function Unread({ count }: { count: number }) {
  if (count <= 0) return null
  return (
    <span
      className="bg-primary text-primary-foreground ml-auto rounded-full px-1.5 text-[10px] font-medium tabular-nums"
      aria-label={`${count} unread`}
    >
      {count > 99 ? '99+' : count}
    </span>
  )
}

function Handles({ connectable }: { connectable: boolean }) {
  return (
    <>
      <Handle type="target" position={Position.Top} isConnectable={connectable} className={handleClass} />
      <Handle type="source" position={Position.Bottom} isConnectable={connectable} className={handleClass} />
    </>
  )
}

function Frame({ selected, className, children }: { selected?: boolean; className?: string; children: React.ReactNode }) {
  return (
    <div className={cn('bg-card rounded-lg border shadow-sm', selected && 'ring-ring ring-2', className)}>{children}</div>
  )
}

export const CrewNode = memo(function CrewNode({ data, selected }: NodeProps<FlowNode>) {
  return (
    <Frame selected={selected} className="flex w-[180px] items-center gap-2 px-3 py-2.5">
      <Network className="text-muted-foreground size-4 shrink-0" />
      <span className="truncate text-sm font-semibold">{data.label}</span>
      <Handles connectable={false} />
    </Frame>
  )
})

export const SquadNode = memo(function SquadNode({ data, selected }: NodeProps<FlowNode>) {
  return (
    <Frame selected={selected} className="flex w-[160px] items-center gap-2 border-dashed px-3 py-2.5">
      <Users className="text-muted-foreground size-4 shrink-0" />
      <span className="truncate text-sm font-medium">{data.label}</span>
      <Handles connectable={false} />
    </Frame>
  )
})

export const UserNode = memo(function UserNode({ data, selected }: NodeProps<FlowNode>) {
  return (
    <Frame selected={selected} className="flex w-[120px] items-center gap-2 px-3 py-2.5">
      <User className="text-muted-foreground size-4 shrink-0" />
      <span className="truncate text-sm font-medium">{data.label}</span>
      <Unread count={data.unread} />
      <Handles connectable={false} />
    </Frame>
  )
})

export const MasterNode = memo(function MasterNode({ data, selected }: NodeProps<FlowNode>) {
  return (
    <Frame selected={selected} className="w-[200px] border-sky-500/40 px-3 py-2.5">
      <div className="flex items-center gap-2">
        {data.status && <StatusDot status={data.status} />}
        <SquareTerminal className="text-muted-foreground size-4 shrink-0" />
        <span className="truncate text-sm font-semibold">{data.label}</span>
        <Unread count={data.unread} />
      </div>
      <div className="text-muted-foreground mt-0.5 pl-[18px] text-[11px]">
        {data.status ? statusLabel[data.status] : 'Not started'}
      </div>
      <Handles connectable />
    </Frame>
  )
})

export const OperatorNode = memo(function OperatorNode({ data, selected }: NodeProps<FlowNode>) {
  const status = data.status ?? 'stopped'
  return (
    <Frame
      selected={selected}
      className={cn('w-[220px] px-3 py-2.5', status === 'running' && 'border-emerald-500/30', status === 'error' && 'border-red-500/40')}
    >
      <div className="flex items-center gap-2">
        <StatusDot status={status} />
        <span className="truncate text-sm font-medium">{data.label}</span>
        <Unread count={data.unread} />
      </div>
      <div className="text-muted-foreground mt-1 truncate text-[11px]">
        {statusLabel[status]}
        {data.agent ? ` - ${data.agent}` : ''}
      </div>
      <div className="text-muted-foreground mt-0.5 truncate text-[11px]">
        {data.job ? (
          <>
            <span className="text-foreground">Job:</span> {data.job}
          </>
        ) : (
          'No job in progress'
        )}
      </div>
      <Handles connectable />
    </Frame>
  )
})

// Defined once at module level: React Flow re-mounts nodes when this object changes identity.
export const nodeTypes = {
  crew: CrewNode,
  squad: SquadNode,
  operator: OperatorNode,
  master: MasterNode,
  user: UserNode,
}
