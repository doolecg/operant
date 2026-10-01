import { Square } from 'lucide-react'
import type { Operator } from '@shared/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { agentLabel } from '@/lib/format'
import { useAction } from '@/lib/queries'
import { OperatorTerminal } from './OperatorTerminal'
import { StatusDot } from './StatusDot'

export function OperatorDrawer({ operator, crewName, onClose }: { operator: Operator | null; crewName: string; onClose: () => void }) {
  const stop = useAction('operators:stop')
  return (
    <Sheet open={operator != null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="flex w-[min(900px,85vw)] flex-col gap-0 p-0 sm:max-w-none">
        {operator && (
          <>
            <SheetHeader className="flex-row items-center gap-3 border-b px-4 py-3">
              <StatusDot status={operator.status} />
              <div className="min-w-0 flex-1">
                <SheetTitle className="font-mono text-sm">
                  {operator.role}@{crewName}
                </SheetTitle>
                <SheetDescription className="text-xs">
                  {agentLabel[operator.agent]}
                  {operator.agent !== 'shell' && operator.model && ` · ${operator.model}`}
                </SheetDescription>
              </div>
              <Badge variant="outline" className="mr-8 font-normal">
                {operator.status}
              </Badge>
            </SheetHeader>
            <div className="min-h-0 flex-1">
              {operator.status === 'running' ? (
                <OperatorTerminal operatorId={operator.id} />
              ) : (
                <div className="text-muted-foreground grid h-full place-items-center text-sm">This operator is not running.</div>
              )}
            </div>
            <div className="flex justify-end border-t px-4 py-2.5">
              <Button
                size="sm"
                variant="secondary"
                disabled={operator.status !== 'running'}
                onClick={() => stop.mutate([operator.id])}
              >
                <Square className="size-3" /> Stop operator
              </Button>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
