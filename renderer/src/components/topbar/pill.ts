// Shared look of the one-row top bar: pills (status, counts, alerts) and 26x24 icon buttons.
export const pill = 'inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-foreground/[0.06] px-2.5 text-xs'
export const pillBtn = `${pill} outline-none transition-colors hover:bg-foreground/10 focus-visible:ring-[3px] focus-visible:ring-ring/50`
export const iconBtn =
  'text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring/50 relative inline-flex h-6 w-[26px] shrink-0 items-center justify-center rounded-full outline-none transition-colors focus-visible:ring-[3px] disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-4'
