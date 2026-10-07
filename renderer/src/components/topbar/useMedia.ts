import { useEffect, useState } from 'react'
import type { MediaState } from '@shared/media'
import { bridge } from '@/lib/bridge'

// The media session from main: the current state, then pushed changes. Position and cover arrive as separate pushes.
export function useMedia(enabled: boolean): MediaState {
  const [state, setState] = useState<MediaState>({ active: false })
  useEffect(() => {
    if (!enabled) {
      setState({ active: false })
      return
    }
    const b = bridge()
    let live = true
    void b.invoke('media:state').then((s) => live && setState(s))
    const offs = [
      b.on('media:state', (s) => setState(s)),
      b.on('media:timeline', (timeline) => setState((s) => ({ ...s, timeline }))),
      b.on('media:art', (art) => setState((s) => ({ ...s, art }))),
    ]
    return () => {
      live = false
      offs.forEach((off) => off())
    }
  }, [enabled])
  return state
}

export const mediaCommand = (cmd: string) => void bridge().invoke('media:command', cmd)
