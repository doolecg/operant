import { useState } from 'react'
import { Pencil, Star, Trash2 } from 'lucide-react'
import type { BrowserHistoryEntry } from '@shared/browser'
import { findBookmark, isBookmarkable, type Bookmark } from '@shared/browser-inspect'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

interface Props {
  currentUrl: string
  currentTitle: string
  bookmarks: readonly Bookmark[]
  history: readonly BrowserHistoryEntry[]
  // Open the address in the current tab.
  onOpen: (url: string) => void
  onAdd: (url: string, title: string) => void
  onEdit: (id: string, patch: { url?: string; title?: string }) => void
  onRemove: (id: string) => void
  onClearHistory: () => void
  disabled?: boolean
}

const MENU_MAX = 12

// The star: bookmarks the page, lists the newest bookmarks, and opens the manager (bookmarks and history).
export function BookmarksMenu(p: Props) {
  const [manage, setManage] = useState<'bookmarks' | 'history' | null>(null)
  const here = findBookmark(p.bookmarks, p.currentUrl)
  const canMark = isBookmarkable(p.currentUrl)

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            aria-label={here ? 'Bookmarks (this page is bookmarked)' : 'Bookmarks'}
            title="Bookmarks"
            disabled={p.disabled}
          >
            <Star className={cn('size-3.5', here && 'fill-primary text-primary')} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          {here ? (
            <DropdownMenuItem onSelect={() => p.onRemove(here.id)}>Remove bookmark for this page</DropdownMenuItem>
          ) : (
            <DropdownMenuItem disabled={!canMark} onSelect={() => p.onAdd(p.currentUrl, p.currentTitle)}>
              Bookmark this page
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          {p.bookmarks.length === 0 ? (
            <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">No bookmarks yet</DropdownMenuLabel>
          ) : (
            p.bookmarks.slice(0, MENU_MAX).map((b) => (
              <DropdownMenuItem key={b.id} title={b.url} onSelect={() => p.onOpen(b.url)}>
                <span className="truncate">{b.title}</span>
              </DropdownMenuItem>
            ))
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setManage('bookmarks')}>Manage bookmarks ({p.bookmarks.length})</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setManage('history')}>History ({p.history.length})</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {manage && <Manager {...p} start={manage} onClose={() => setManage(null)} />}
    </>
  )
}

function Manager(p: Props & { start: 'bookmarks' | 'history'; onClose: () => void }) {
  const [tab, setTab] = useState<string>(p.start)
  const [editing, setEditing] = useState<Bookmark | null>(null)
  const [removing, setRemoving] = useState<Bookmark | null>(null)
  const [clearing, setClearing] = useState(false)
  const [filter, setFilter] = useState('')

  const q = filter.trim().toLowerCase()
  const hit = (title: string, url: string) => q === '' || `${title} ${url}`.toLowerCase().includes(q)
  const marks = p.bookmarks.filter((b) => hit(b.title, b.url))
  const visits = p.history.filter((h) => hit(h.title, h.url))

  const open = (url: string) => {
    p.onOpen(url)
    p.onClose()
  }

  return (
    <>
      <Dialog open onOpenChange={(o) => !o && p.onClose()}>
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>Bookmarks and history</DialogTitle>
            <DialogDescription>Kept per project, like the project's cookies and logins.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 px-6">
            <Input aria-label="Filter bookmarks and history" placeholder="Filter" spellCheck={false} autoComplete="off" value={filter} onChange={(e) => setFilter(e.target.value)} className="h-8 text-sm" />
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList>
                <TabsTrigger value="bookmarks">Bookmarks ({p.bookmarks.length})</TabsTrigger>
                <TabsTrigger value="history">History ({p.history.length})</TabsTrigger>
              </TabsList>
              <TabsContent value="bookmarks" className="max-h-80 overflow-y-auto">
                {marks.length === 0 && <p className="text-muted-foreground p-3 text-sm">{p.bookmarks.length === 0 ? 'No bookmarks yet. Use the star menu to add the current page.' : 'Nothing matches.'}</p>}
                <ul>
                  {marks.map((b) => (
                    <li key={b.id} className="hover:bg-accent/50 flex items-center gap-1 rounded-md px-2 py-1">
                      <button type="button" aria-label={`Open ${b.title}`} className="min-w-0 flex-1 text-left outline-none" onClick={() => open(b.url)}>
                        <span className="block truncate text-sm">{b.title}</span>
                        <span className="text-muted-foreground block truncate text-xs">{b.url}</span>
                      </button>
                      <Button type="button" variant="ghost" size="icon-xs" aria-label={`Edit ${b.title}`} title="Edit" onClick={() => setEditing(b)}>
                        <Pencil />
                      </Button>
                      <Button type="button" variant="ghost" size="icon-xs" aria-label={`Delete ${b.title}`} title="Delete" onClick={() => setRemoving(b)}>
                        <Trash2 />
                      </Button>
                    </li>
                  ))}
                </ul>
              </TabsContent>
              <TabsContent value="history" className="max-h-80 overflow-y-auto">
                {visits.length === 0 && <p className="text-muted-foreground p-3 text-sm">{p.history.length === 0 ? 'No pages visited yet.' : 'Nothing matches.'}</p>}
                <ul>
                  {visits.map((h) => (
                    <li key={h.url} className="hover:bg-accent/50 flex items-center gap-1 rounded-md px-2 py-1">
                      <button type="button" aria-label={`Open ${h.title || h.url}`} className="min-w-0 flex-1 text-left outline-none" onClick={() => open(h.url)}>
                        <span className="block truncate text-sm">{h.title || h.url}</span>
                        <span className="text-muted-foreground block truncate text-xs">{h.url}</span>
                      </button>
                      <span className="text-muted-foreground shrink-0 text-xs">{new Date(h.at).toLocaleString()}</span>
                    </li>
                  ))}
                </ul>
              </TabsContent>
            </Tabs>
          </div>
          <DialogFooter>
            {tab === 'history' && (
              <Button variant="outline" disabled={p.history.length === 0} onClick={() => setClearing(true)}>
                Clear history
              </Button>
            )}
            <Button onClick={p.onClose}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {editing && <EditDialog bookmark={editing} onClose={() => setEditing(null)} onSave={(patch) => p.onEdit(editing.id, patch)} />}
      <ConfirmDialog
        open={removing !== null}
        title="Delete bookmark"
        description={removing ? `Delete the bookmark "${removing.title}"? ${String(p.bookmarks.length - 1)} bookmark${p.bookmarks.length === 2 ? '' : 's'} will be left.` : ''}
        confirmLabel="Delete"
        danger
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (removing) p.onRemove(removing.id)
          setRemoving(null)
        }}
      />
      <ConfirmDialog
        open={clearing}
        title="Clear history"
        description={`Clear ${String(p.history.length)} visited page${p.history.length === 1 ? '' : 's'} from this project's history? Bookmarks, cookies and logins are kept.`}
        confirmLabel="Clear history"
        danger
        onCancel={() => setClearing(false)}
        onConfirm={() => {
          p.onClearHistory()
          setClearing(false)
        }}
      />
    </>
  )
}

function EditDialog({ bookmark, onClose, onSave }: { bookmark: Bookmark; onClose: () => void; onSave: (patch: { url: string; title: string }) => void }) {
  const [title, setTitle] = useState(bookmark.title)
  const [url, setUrl] = useState(bookmark.url)
  const valid = isBookmarkable(url.trim())
  const save = () => {
    if (!valid) return
    onSave({ url: url.trim(), title: title.trim() })
    onClose()
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        size="sm"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault()
            save()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Edit bookmark</DialogTitle>
          <DialogDescription>Change the name or the address.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 px-6">
          <div className="grid gap-1.5">
            <Label htmlFor="bm-title">Name</Label>
            <Input id="bm-title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="bm-url">Address</Label>
            <Input id="bm-url" spellCheck={false} value={url} onChange={(e) => setUrl(e.target.value)} aria-invalid={!valid} />
            {!valid && (
              <p role="alert" className="text-destructive text-xs">
                Enter a full http or https address
              </p>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!valid}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
