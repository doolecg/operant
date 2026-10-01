// The shell renders from these lists: add a crew view, a right-panel tab or a dialog here and in its own
// component file, nothing else.
import type { ComponentType } from 'react'
import { LayoutGrid, List, Network, SquareTerminal, type LucideIcon } from 'lucide-react'
import type { KeyAction } from '@shared/settings'
import type { CrewTopology, CrewView, Operator } from '@shared/types'
import { ChangeModelEffortDialog } from '@/components/dialogs/ChangeModelEffortDialog'
import { CardsView } from '@/components/views/CardsView'
import { GraphView } from '@/components/views/GraphView'
import { ListView } from '@/components/views/ListView'
import { TilesView } from '@/components/views/TilesView'
import { ActivityPanel } from '@/components/panels/ActivityPanel'
import { CostPanel } from '@/components/panels/CostPanel'
import { JobsPanel, useJobsBadge } from '@/components/panels/JobsPanel'
import { MessagesPanel, useMessagesBadge } from '@/components/panels/MessagesPanel'

// What the shell hands every crew view. A view fetches anything else itself with the query hooks.
export interface ViewProps {
  crewId: number
  crew: CrewTopology
  onOpenOperator: (operator: Operator) => void
  onAddOperator: (squadId: number) => void
  onAddSquad: () => void
}

export interface CrewViewEntry {
  id: CrewView
  label: string
  icon: LucideIcon
  component: ComponentType<ViewProps>
  keybind: KeyAction
}

export const CREW_VIEWS: CrewViewEntry[] = [
  { id: 'cards', label: 'Cards', icon: LayoutGrid, component: CardsView, keybind: 'viewCards' },
  { id: 'list', label: 'List', icon: List, component: ListView, keybind: 'viewList' },
  { id: 'graph', label: 'Graph', icon: Network, component: GraphView, keybind: 'viewGraph' },
  { id: 'tiles', label: 'Tiles', icon: SquareTerminal, component: TilesView, keybind: 'viewTiles' },
]

export const DEFAULT_VIEW: CrewView = 'cards'

// What the shell hands every right-panel tab. A tab scrolls itself (it may want a pinned composer).
export interface TabProps {
  crewId: number
  operators: Operator[]
}

export interface PanelTab {
  id: string
  label: string
  component: ComponentType<TabProps>
  keybind: KeyAction
  // A small count shown next to the label; hidden when 0 or undefined.
  useBadge?: (crewId: number | null) => number | undefined
}

export const PANEL_TABS: PanelTab[] = [
  { id: 'activity', label: 'Activity', component: ActivityPanel, keybind: 'tabActivity' },
  { id: 'jobs', label: 'Jobs', component: JobsPanel, keybind: 'tabJobs', useBadge: useJobsBadge },
  { id: 'messages', label: 'Messages', component: MessagesPanel, keybind: 'tabMessages', useBadge: useMessagesBadge },
  { id: 'cost', label: 'Cost', component: CostPanel, keybind: 'tabCost' },
]

// Dialogs opened from anywhere with openDialog(id, payload) (lib/dialogs.ts).
export interface DialogProps<P = unknown> {
  payload: P | undefined
  onClose: () => void
}

export interface ChangeModelEffortPayload {
  operatorId: number
}

export const DIALOGS: Record<string, ComponentType<DialogProps<any>>> = {
  changeModelEffort: ChangeModelEffortDialog,
}
