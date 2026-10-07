import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Music2, Pause, Play, Shuffle, SkipBack, SkipForward, Volume2, VolumeX } from 'lucide-react'
import type { MediaSize, MediaState } from '@shared/media'
import { cn } from '@/lib/utils'
import { mediaCommand, useMedia } from './useMedia'

// The title scrolls sideways when it does not fit; short titles stay still.
function Marquee({ text, className }: { text: string; className?: string }) {
  const box = useRef<HTMLSpanElement>(null)
  const inner = useRef<HTMLSpanElement>(null)
  const [shift, setShift] = useState(0)
  useLayoutEffect(() => {
    const over = (inner.current?.scrollWidth ?? 0) - (box.current?.clientWidth ?? 0)
    setShift(over > 2 ? over : 0)
  }, [text])
  return (
    <span ref={box} className={cn('block min-w-0 overflow-hidden whitespace-nowrap', className)}>
      <span
        ref={inner}
        className={cn('inline-block', shift > 0 && 'media-marquee')}
        style={shift > 0 ? ({ '--shift': `-${shift}px`, '--dur': `${Math.max(6, shift / 12)}s` } as React.CSSProperties) : undefined}
      >
        {text}
      </span>
    </span>
  )
}

// Seconds into the track, counted on from the last report every half second.
function useProgress(s: MediaState): { pos: number; dur: number } | null {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!s.playing) return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [s.playing])
  const t = s.timeline
  if (!t || t.dur <= 0) return null
  const pos = t.pos + (s.playing ? Math.max(0, (now - t.at) / 1000) : 0)
  return { pos: Math.min(t.dur, pos), dur: t.dur }
}

const btn =
  'text-muted-foreground hover:text-foreground disabled:opacity-40 grid size-6 shrink-0 place-items-center rounded-full transition-colors [&_svg]:size-3'

// `tier` is the top bar's squeeze level (useBarTier): from 1 the controls are gone (cover and title stay), from 3 the title
// is shorter. The compact block shows only art and title until hovered, focused or while the volume is dragged.
export function MediaBar({ enabled, size, tier = 0 }: { enabled: boolean; size: MediaSize; tier?: number }) {
  const s = useMedia(enabled)
  const progress = useProgress(s)
  const [vol, setVol] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const lastVol = useRef(0.5)
  const sentAt = useRef(0)
  const volume = vol ?? (s.volume != null && s.volume >= 0 ? s.volume : 0)
  useEffect(() => setVol(null), [s.volume])
  useEffect(() => {
    if (!dragging) return
    const up = () => setDragging(false)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => (window.removeEventListener('pointerup', up), window.removeEventListener('pointercancel', up))
  }, [dragging])
  if (!enabled || !s.active) return null

  const setVolume = (v: number) => {
    setVol(v)
    if (v > 0) lastVol.current = v
    const now = Date.now()
    if (now - sentAt.current > 80 || v === 0 || v === 1) {
      sentAt.current = now
      mediaCommand(`vol ${v.toFixed(3)}`)
    }
  }
  const full = size === 'full'
  const pct = progress ? (progress.pos / progress.dur) * 100 : 0
  const controls = tier < 1
  // Compact hides the controls by width and fades them in; full keeps them in the row.
  const hold = full
    ? ''
    : cn(
        'max-w-0 overflow-hidden opacity-0 transition-[max-width,opacity] duration-200 group-hover/media:max-w-[240px] group-hover/media:opacity-100 group-focus-within/media:max-w-[240px] group-focus-within/media:opacity-100',
        dragging && 'max-w-[240px] opacity-100',
      )
  const title = `${s.title ?? ''}${s.artist ? ` - ${s.artist}` : ''}${s.appName ? ` (${s.appName})` : ''}: click to focus the player`

  return (
    <div
      role="group"
      aria-label="Media controls"
      className={cn(
        'group/media bg-foreground/5 relative flex min-w-[96px] shrink items-center overflow-hidden rounded-lg',
        full ? 'h-[34px] gap-1.5 py-0.5 pl-1 pr-2' : 'h-[30px] pl-[3px] pr-3',
      )}
    >
      <div className={cn('bg-muted grid shrink-0 place-items-center overflow-hidden', full ? 'size-6 rounded-[5px]' : 'size-[18px] rounded')}>
        {s.art ? <img src={s.art} alt="" className="size-full object-cover" /> : <Music2 className="text-muted-foreground size-3" />}
      </div>
      <button
        type="button"
        onClick={() => mediaCommand('focus')}
        title={title}
        className={cn('min-w-0 text-left', full ? 'w-36' : 'ml-1.5 max-w-[180px]', tier >= 1 && 'max-w-[130px]', tier >= 3 && 'max-w-[110px]', tier >= 4 && 'max-w-[80px]')}
      >
        <Marquee text={s.title || 'Unknown'} className="text-xs font-medium" />
        {full && s.artist && <span className="text-muted-foreground block truncate text-[10.5px] leading-tight">{s.artist}</span>}
      </button>
      {controls && (
        <div className={cn('flex shrink-0 items-center', hold)}>
          <button type="button" className={btn} aria-label="Previous track" disabled={!s.canPrev} onClick={() => mediaCommand('prev')}>
            <SkipBack />
          </button>
          <button
            type="button"
            className={cn(btn, 'text-foreground [&_svg]:size-3 [&_svg]:fill-current')}
            aria-label={s.playing ? 'Pause' : 'Play'}
            disabled={!s.canPlayPause}
            onClick={() => mediaCommand('toggle')}
          >
            {s.playing ? <Pause /> : <Play />}
          </button>
          <button type="button" className={btn} aria-label="Next track" disabled={!s.canNext} onClick={() => mediaCommand('next')}>
            <SkipForward />
          </button>
          <>
            <button
              type="button"
              className={cn(btn, s.shuffle && 'text-primary')}
              aria-label="Shuffle"
              aria-pressed={!!s.shuffle}
              disabled={!s.canShuffle}
              onClick={() => mediaCommand('shuffle')}
            >
              <Shuffle />
            </button>
            <button type="button" className={btn} aria-label={volume === 0 ? 'Unmute' : 'Mute'} onClick={() => setVolume(volume === 0 ? lastVol.current : 0)}>
              {volume === 0 ? <VolumeX /> : <Volume2 />}
            </button>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(volume * 100)}
              aria-label="Volume"
              disabled={s.volume == null || s.volume < 0}
              onPointerDown={() => setDragging(true)}
              onChange={(e) => setVolume(Number(e.target.value) / 100)}
              className="accent-primary mx-1 h-1 w-[78px] shrink-0"
            />
          </>
        </div>
      )}
      {progress && (
        <div
          role="progressbar"
          aria-label="Track position"
          aria-valuenow={Math.round(pct)}
          className="bg-foreground/10 pointer-events-none absolute inset-x-2 bottom-0 h-0.5 overflow-hidden rounded-full"
        >
          <div className="bg-primary h-full" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  )
}
