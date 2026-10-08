import type { JobAgent } from '@shared/types'
import { AgentLog } from '@/components/jobs/AgentView'

// A subagent runs inside the Master CLI, so it has no terminal: its tile is the read-only tail of its transcript.
export function SubagentTile({ agent }: { agent: JobAgent }) {
  return (
    <div className="bg-background flex h-full min-h-0 flex-col p-2" data-testid="subagent-tile" data-agent-status={agent.status}>
      <AgentLog runId={agent.runId} agentId={agent.id} seat={agent.seat} live={agent.status !== 'done'} />
    </div>
  )
}
