import { useEffect } from 'react'
import type { Crew } from '@shared/types'

// "Show changes" and the branch chip lead to the Git page (the Git tab of the project's workspace); there is no dialog of its own.
export function GitChangesDialog({ crew, onClose, onOpenPage }: { crew: Crew; onClose: () => void; onOpenPage: (crew: Crew) => void }) {
  useEffect(() => {
    onOpenPage(crew)
    onClose()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return null
}
