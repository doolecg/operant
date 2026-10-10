import { useEffect, useRef, useState } from 'react'
import { clockText, dateText, fullDateTime, isoWeek, monthGrid, type ClockFormat } from '@shared/media'
import { toast } from '@/lib/toast'

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']

function Calendar({ now }: { now: Date }) {
  const grid = monthGrid(now)
  return (
    <div role="dialog" aria-label="Calendar" className="bg-popover text-popover-foreground absolute right-0 top-full z-50 mt-1 w-56 rounded-xl border p-2 text-xs shadow-lg">
      <div className="mb-1 flex justify-between font-medium">
        <span>{now.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
        <span className="text-muted-foreground">week {isoWeek(now)}</span>
      </div>
      <table className="w-full text-center">
        <thead>
          <tr className="text-muted-foreground">
            <th className="font-normal">wk</th>
            {WEEKDAYS.map((d) => (
              <th key={d} className="font-normal">
                {d}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.map((w, i) => (
            <tr key={i}>
              <td className="text-muted-foreground font-mono text-[10px]">{w.week}</td>
              {w.days.map((d, j) => (
                <td key={j} className={d === now.getDate() ? 'bg-primary text-primary-foreground rounded-full' : ''}>
                  {d ?? ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// The time (and date) pill: click copies the full date and time, hovering for a moment shows the month.
export function ClockPill({ format, seconds, date }: { format: ClockFormat; seconds: boolean; date: boolean }) {
  const [now, setNow] = useState(() => new Date())
  const [open, setOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => {
    setNow(new Date())
    const t = setInterval(() => setNow(new Date()), seconds ? 1000 : 10_000)
    return () => clearInterval(t)
  }, [seconds])
  useEffect(() => () => clearTimeout(timer.current), [])

  const copy = () => {
    const text = fullDateTime(now, { format })
    navigator.clipboard.writeText(text).then(
      () => toast(`Copied ${text}`),
      () => toast('Could not copy the date', true),
    )
  }
  return (
    <div
      className="relative shrink-0"
      onMouseEnter={() => {
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setOpen(true), 350)
      }}
      onMouseLeave={() => {
        clearTimeout(timer.current)
        setOpen(false)
      }}
    >
      <button
        type="button"
        onClick={copy}
        aria-label={`Clock ${fullDateTime(now, { format })}; click to copy`}
        className="hover:bg-foreground/10 flex h-6 items-center gap-2 rounded-full px-2 font-mono text-xs tabular-nums transition-colors"
      >
        <span data-testid="clock-time">{clockText(now, { format, seconds })}</span>
        {date && <span className="text-muted-foreground">{dateText(now)}</span>}
      </button>
      {open && <Calendar now={now} />}
    </div>
  )
}
