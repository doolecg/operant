import { useQuery } from '@tanstack/react-query'
import { notify } from '@/lib/notices'
import type { UpdateStatus } from '@shared/types'
import { call, keys, registerLive } from './core'

export const useUpdateStatus = () => useQuery({ queryKey: keys.update, queryFn: () => call('update:status') })

// The last status seen, so a notice goes out once per change (available, downloaded), not on every push.
let last: { state?: string; version?: string } = {}

function noteUpdate(s: UpdateStatus) {
  const changed = s.state !== last.state || s.version !== last.version
  last = { state: s.state, version: s.version }
  if (!changed || !s.version) return
  if (s.state === 'downloading') notify(`Update ${s.version} is available and downloading.`)
  if (s.state === 'ready') notify(`Update ${s.version} is downloaded and ready to install.`)
}

registerLive((b, qc) => [
  b.on('update', (s) => {
    qc.setQueryData(keys.update, s)
    noteUpdate(s)
  }),
])
