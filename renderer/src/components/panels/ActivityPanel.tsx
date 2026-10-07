import { ActivityFeed } from '@/components/dashboard/ActivityFeed'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useEvents } from '@/lib/queries'

export function ActivityPanel({ crewId }: { crewId: number }) {
  const events = useEvents()
  return (
    <ScrollArea className="h-full">
      <ActivityFeed events={events.data ?? []} crewId={crewId} />
    </ScrollArea>
  )
}
