import { ActivityFeed } from '@/components/dashboard/ActivityFeed'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useEvents } from '@/lib/queries'
import type { TabProps } from '@/registry'

export function ActivityPanel({ crewId }: TabProps) {
  const events = useEvents()
  return (
    <ScrollArea className="h-full">
      <ActivityFeed events={events.data ?? []} crewId={crewId} />
    </ScrollArea>
  )
}
