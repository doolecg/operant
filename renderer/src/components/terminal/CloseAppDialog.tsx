import { useEffect, useState } from 'react'
import { appCloseLines, type RunningCounts } from '@shared/notify'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { bridge } from '@/lib/bridge'
import { call } from '@/lib/queries'

// Shown when the window is closed while terminals run. The main process waits for 'shown' (or closes anyway after a few
// seconds), then for 'quit' (confirmed) or 'stay' (cancelled).
export function CloseAppDialog() {
  const [counts, setCounts] = useState<RunningCounts | null>(null)

  useEffect(
    () =>
      bridge().on('app:closeRequest', (c) => {
        setCounts(c)
        void call('app:closeReply', 'shown').catch(() => undefined)
      }),
    [],
  )

  return (
    <ConfirmDialog
      open={counts != null}
      testId="close-app-dialog"
      title="Close Operant?"
      description={counts ? appCloseLines(counts).join('\n') : ''}
      confirmLabel="Close Operant"
      dontAskLabel="Don't ask again"
      danger
      onConfirm={(dontAsk) => {
        setCounts(null)
        const saved = dontAsk ? call('settings:set', { confirm: { closeApp: false } }).catch(() => undefined) : Promise.resolve()
        void saved.then(() => call('app:closeReply', 'quit')).catch(() => undefined)
      }}
      onCancel={() => {
        setCounts(null)
        void call('app:closeReply', 'stay').catch(() => undefined)
      }}
    />
  )
}
