import { useCallback, useRef, useState } from 'react'
import { shouldConfirmTileClose, tileCloseCopy, type TileKind } from '@shared/notify'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { call } from '@/lib/queries'
import type { TerminalTab } from './useTerminals'

interface Pending {
  scratchId: number
  title: string
  kind: TileKind
  busy: boolean
}

// Closing a terminal or chat tile asks first (unless the owner turned the ask off or the process already ended).
export function useCloseTile(tabs: TerminalTab[], askEnabled: boolean, closeTab: (scratchId: number) => void) {
  const [pending, setPending] = useState<Pending | null>(null)
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const askRef = useRef(askEnabled)
  askRef.current = askEnabled

  const request = useCallback(
    async (scratchId: number) => {
      const tab = tabsRef.current.find((t) => t.scratchId === scratchId)
      if (!tab || !shouldConfirmTileClose(askRef.current, tab.exited)) return closeTab(scratchId)
      const busy = await call('turn:busy', scratchId).catch(() => false)
      setPending({ scratchId, title: tab.title, kind: tab.kind, busy })
    },
    [closeTab],
  )

  const copy = pending ? tileCloseCopy({ title: pending.title, kind: pending.kind, busy: pending.busy }) : null
  const dialog = (
    <ConfirmDialog
      open={pending != null}
      testId="close-tile-dialog"
      title={copy?.title ?? ''}
      description={copy?.body ?? ''}
      confirmLabel="Close"
      dontAskLabel="Don't ask again"
      danger
      onConfirm={(dontAsk) => {
        const p = pending
        setPending(null)
        if (!p) return
        if (dontAsk) void call('settings:set', { confirm: { closeTile: false } }).catch(() => undefined)
        closeTab(p.scratchId)
      }}
      onCancel={() => setPending(null)}
    />
  )
  return { request, dialog }
}
