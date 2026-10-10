import { memo, useMemo } from 'react'
import { buildRows, type ChatItem } from '@shared/claude-chat'
import { AssistantText, CommandRow, NoticeRow, SubagentRow, ThinkingRow, ToolGroupRow, ToolRow, TurnRow, UserBubble } from './ItemViews'
import { PermissionCard, PlanCard, QuestionCard } from './PromptCards'
import { cn } from '@/lib/utils'
import { chatActions } from './useChat'

interface Props {
  scratchId: number
  items: ChatItem[]
  onOpenAgent: (agentItemId: string) => void
  onTerminal: () => void
  // The Agents panel's smaller style.
  small?: boolean
  // Prompts are answered in the main chat only; elsewhere they show as a muted pointer.
  prompts?: boolean
}

const ItemView = memo(function ItemView({ scratchId, item, onOpenAgent, onTerminal, small, prompts }: Omit<Props, 'items'> & { item: ChatItem }) {
  switch (item.kind) {
    case 'user':
      return <UserBubble item={item} small={small} />
    case 'text':
      return <AssistantText item={item} small={small} />
    case 'thinking':
      return <ThinkingRow item={item} />
    case 'tool':
      return <ToolRow t={item} small={small} />
    case 'subagent':
      return <SubagentRow item={item} onOpen={onOpenAgent} small={small} />
    case 'permission':
      return prompts === false ? <Pointer answered={item.answer !== null} /> : <PermissionCard scratchId={scratchId} item={item} />
    case 'question':
      return prompts === false ? <Pointer answered={item.answers !== null} /> : <QuestionCard scratchId={scratchId} item={item} />
    case 'plan':
      return prompts === false ? <Pointer answered={item.answer !== null} /> : <PlanCard scratchId={scratchId} item={item} />
    case 'command':
      return <CommandRow item={item} />
    case 'notice':
      return <NoticeRow item={item} onRestart={() => void chatActions.restart(scratchId)} onTerminal={onTerminal} />
    case 'turn':
      return <TurnRow item={item} />
  }
})

function Pointer({ answered }: { answered: boolean }) {
  return <div className="text-muted-foreground text-xs">{answered ? 'Answered in the chat' : 'Waiting for your answer in the chat'}</div>
}

// Long conversations stay cheap: off-screen rows skip layout and paint (the newest ones always render).
const lazy = '[content-visibility:auto] [contain-intrinsic-size:auto_60px]'

export const ConversationList = memo(function ConversationList({ scratchId, items, onOpenAgent, onTerminal, small, prompts = true }: Props) {
  const rows = useMemo(() => buildRows(items), [items])
  return (
    <>
      {rows.map((row, i) => {
        const fresh = i >= rows.length - 6
        const cls = fresh ? undefined : lazy
        if (row.type === 'toolGroup')
          return (
            <div key={row.id} className={cls}>
              <ToolGroupRow summary={row.summary} items={row.items} small={small} />
            </div>
          )
        return (
          <div key={row.item.id} className={cn(cls, row.item.kind === 'user' && 'flex justify-end')} data-item={row.item.kind}>
            <ItemView scratchId={scratchId} item={row.item} onOpenAgent={onOpenAgent} onTerminal={onTerminal} small={small} prompts={prompts} />
          </div>
        )
      })}
    </>
  )
})
